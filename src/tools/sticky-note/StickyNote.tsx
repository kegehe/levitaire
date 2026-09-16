import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import {
  getNoteColor,
  IMG_TOKEN_PATTERN,
  isNoteImgRel,
  NOTE_COLORS,
  parseNoteIdFromLabel,
} from "./constants";
import { clampWindowToWorkArea } from "../../utils/panelWindow";
import "./StickyNote.css";

/** 与后端 sticky_note::NOTE_WIDTH_LOGICAL 一致（逻辑像素） */
const NOTE_WIDTH = 264;

/**
 * 「便签已不存在」的后端错误文案（`sticky_note/mod.rs` 里的 `ok_or_else`）。
 *
 * ⚠️ 这是**跨端契约**：只有确认「它真的没了」才允许销毁窗口；其它任何错误（瞬时 IPC
 * 失败、锁中毒）都必须保留窗口并给一张可重试的卡片。以前不区分、一律 `destroy()`，
 * 于是一次瞬时失败就把用户正看着的便签窗销毁掉，而数据里它仍是 visible=true ——
 * 管理窗显示「已贴在桌面」、桌面上却没有窗口，用户看不到任何解释。
 *
 * 两侧的字面量由后端守卫测试 `not_found_message_is_a_cross_boundary_contract` 钉住：
 * 改后端文案而不改这里，守卫会报红（否则行为会静默退回「任何错误都销毁窗口」）。
 */
const NOTE_NOT_FOUND_MARKER = "便利贴不存在";

/** 块级标签：序列化时在这些元素之间补换行 */
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3"]);

/**
 * 把 contenteditable 的 DOM 序列化为纯文本。
 * 不用 innerText（happy-dom/部分环境不一致）：文本节点原样保留（配合
 * white-space: pre-wrap 渲染换行），块级元素之间补换行，<br> 视为换行。
 * 便利贴图片 <img data-note-img> 序列化为 `[[img:相对路径]]` 令牌。
 */
function serializeEditorText(root: Node): string {
  let out = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR") {
      if (!out.endsWith("\n")) out += "\n";
      return;
    }
    if (tag === "IMG") {
      const rel = el.getAttribute("data-note-img");
      if (rel) out += `[[img:${rel}]]`;
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      if (out.length > 0 && !out.endsWith("\n")) out += "\n";
      el.childNodes.forEach((child) => visit(child));
      if (!out.endsWith("\n")) out += "\n";
      return;
    }
    el.childNodes.forEach((child) => visit(child));
  };
  visit(root);
  // 压缩连续空行，去除首尾空白（与后端存储的 trim 语义一致）
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function readEditorText(editor: HTMLElement | null): string {
  return editor ? serializeEditorText(editor) : "";
}

/**
 * 建立一张便签图片的 <img> 节点。相对路径存于 data-note-img，src 用
 * convertFileSrc 指向 asset 协议；alt 给定占位提示。
 * onLoad：图片异步解码完成后触发，供外层重算窗口高度（image 载入前 height 为 0）。
 */
function createNoteImage(
  owner: Document,
  rel: string,
  src: string,
  onLoad?: () => void,
): HTMLImageElement {
  const img = owner.createElement("img");
  img.setAttribute("data-note-img", rel);
  if (src) img.src = src;
  img.alt = "便利贴图片";
  img.draggable = false;
  if (onLoad) img.addEventListener("load", onLoad);
  return img;
}

/**
 * 把正文（含 `[[img:相对路径]]` 令牌）渲染进 editor。
 * split 保留捕获组 → 偶数下标为文本段、奇数下标为图片相对路径，二者交错。
 * 仅当相对路径符合后端命名格式（isNoteImgRel）才还原为 <img>；否则视为
 * 用户字面输入的 `[[img:...]]` 文本原样保留，避免被不可逆改写成破图。
 */
function renderEditorContent(
  editor: HTMLElement,
  content: string,
  resolveSrc: (rel: string) => string,
  onImgLoad?: () => void,
): void {
  editor.textContent = "";
  const parts = content.split(new RegExp(IMG_TOKEN_PATTERN, "g"));
  const frag = editor.ownerDocument.createDocumentFragment();
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      if (isNoteImgRel(part)) {
        frag.appendChild(createNoteImage(editor.ownerDocument, part, resolveSrc(part), onImgLoad));
      } else {
        frag.appendChild(editor.ownerDocument.createTextNode(`[[img:${part}]]`));
      }
    } else if (part) {
      frag.appendChild(editor.ownerDocument.createTextNode(part));
    }
  });
  editor.appendChild(frag);
}

interface StickyNote {
  id: string;
  content: string;
  colorId: string;
  visible: boolean;
  updatedAt?: string;
}

function StickyNote() {
  // getCurrentWebviewWindow() 每次调用返回新对象，仅取首次值保证 effect 稳定
  const winRef = useRef(getCurrentWebviewWindow());
  const win = winRef.current;
  const noteIdRef = useRef<string>(parseNoteIdFromLabel(win.label));

  const [note, setNote] = useState<StickyNote | null>(null);
  // 读取失败（且便签确实还在）时进入可重试的失败态，见下方 loadNote
  const [loadFailed, setLoadFailed] = useState(false);
  const [colorId, setColorId] = useState<string>("yellow");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  // 便利贴图片根目录（后端 app_data_dir/sticky-images）。state 用于驱动
  // 目录就绪后的补图 effect；ref 供异步回调读取最新值，避免闭包取到旧空串。
  const [imagesDir, setImagesDir] = useState("");
  const imagesDirRef = useRef("");

  const editorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const latestTextRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const lastHeightRef = useRef(0);
  const positionTimerRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);
  const destroyedRef = useRef(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const pasteErrorTimer = useRef<number | null>(null);

  /**
   * 统一的短暂提示（复用原有 `.sn-paste-error` 提示条）。
   * 粘贴图片、保存正文、读取便签失败都走它 —— 这些路径以前只 `console.error`，
   * 用户零感知：以为已经存住了，刷新后内容却回退甚至丢失。
   */
  const showNotice = useCallback((message: string) => {
    setPasteError(message);
    if (pasteErrorTimer.current) clearTimeout(pasteErrorTimer.current);
    pasteErrorTimer.current = window.setTimeout(() => setPasteError(null), 3500);
  }, []);

  const color = getNoteColor(colorId);

  // 主题（单张便签独立窗口，需手动应用与订阅）
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
  }, []);
  useEffect(() => {
    const un = subscribeThemePreferences();
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 读取便签内容；已删除（如被管理窗删掉）时自毁窗口。
  //
  // 只有「确实已不存在」才允许自毁：以前任何错误都会 `win.destroy()` —— 一次瞬时的
  // IPC/锁失败就把用户正在看的便签窗销毁掉，而数据里它仍是 visible=true，管理窗于是
  // 显示「已贴在桌面」但桌面没有窗口，用户也看不到任何解释。瞬时失败改为在窗内给出
  // 可操作的失败态（重试），窗口本身保留。
  const loadNote = useCallback(async () => {
    try {
      const data = await invoke<StickyNote>("get_sticky_note", { id: noteIdRef.current });
      setNote(data);
      setColorId(data.colorId || "yellow");
      setLoadFailed(false);
    } catch (error) {
      const message = typeof error === "string" ? error : "";
      // 判定依据见 NOTE_NOT_FOUND_MARKER：只有「确实没了」才销毁窗口
      if (message.includes(NOTE_NOT_FOUND_MARKER)) {
        void win.destroy().catch(() => {});
        return;
      }
      console.error("读取便利贴失败:", error);
      setLoadFailed(true);
    }
  }, [win]);

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  // 拉取便利贴图片根目录，供 convertFileSrc 解析令牌为可显示地址
  useEffect(() => {
    void invoke<string>("get_sticky_note_images_dir")
      .then((dir) => {
        imagesDirRef.current = dir;
        setImagesDir(dir);
      })
      .catch(() => {});
  }, []);

  // 新建的空便签：如果窗口已获焦则直接把光标放进正文，方便立即输入
  useEffect(() => {
    if (!note || !isEmpty) return;
    const timer = window.setTimeout(() => {
      void win
        .isFocused()
        .then((focused) => {
          if (focused) editorRef.current?.focus();
        })
        .catch(() => {});
    }, 120);
    return () => window.clearTimeout(timer);
  }, [note, isEmpty]);

  /** 内容高度自适应：测量外层高度并调整窗口高度（宽度固定） */
  const scheduleResize = useCallback(() => {
    if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      const root = rootRef.current;
      if (!root) return;
      const height = Math.ceil(root.offsetHeight);
      if (height > 0 && height !== lastHeightRef.current) {
        lastHeightRef.current = height;
        win.setSize(new LogicalSize(NOTE_WIDTH, height)).catch(() => {});
        // 便签越写越高：贴着屏幕下沿的便签若不重新夹，底部几行会落到工作区外。
        clampWindowToWorkArea(NOTE_WIDTH, height);
      }
    }, 40);
  }, []);

  // 读取失败的卡片也要量一次高度：该分支 `note` 为 null，下面的水合 effect 不会跑，
  // 少了这一次窗口会停在创建时的 180px，卡片要么被裁、要么下方留一大片透明。
  useEffect(() => {
    if (loadFailed) scheduleResize();
  }, [loadFailed, scheduleResize]);

  // note 渲染完成后（editor 已挂载）再水合正文；不能在上面的 then 中直接写
  // editorRef——此时新分支尚未提交，ref 仍为 null。正文始终立即水合（纯文本
  // 不依赖图片目录）；图片 src 若目录未就绪则留空并隐藏，由下方补图 effect 负责。
  useEffect(() => {
    if (!note || hydratedRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    hydratedRef.current = true;
    renderEditorContent(
      editor,
      note.content,
      (rel) => {
        const dir = imagesDirRef.current;
        return dir ? convertFileSrc(`${dir}/${rel}`) : "";
      },
      () => scheduleResize(),
    );
    latestTextRef.current = note.content;
    setIsEmpty(note.content.trim().length === 0);
    scheduleResize();
  }, [note, scheduleResize]);

  // 图片目录就绪后，为水合/粘贴时尚未拿到目录的 <img> 补上 src 并重算高度
  useEffect(() => {
    if (!imagesDir) return;
    const editor = editorRef.current;
    if (!editor) return;
    let touched = false;
    editor.querySelectorAll("img[data-note-img]").forEach((node) => {
      const img = node as HTMLImageElement;
      if (!img.getAttribute("src")) {
        img.setAttribute(
          "src",
          convertFileSrc(`${imagesDir}/${img.getAttribute("data-note-img")}`),
        );
        touched = true;
      }
    });
    if (touched) scheduleResize();
  }, [imagesDir, scheduleResize]);

  /** 保存正文（防抖） */
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (destroyedRef.current) return;
    const id = noteIdRef.current;
    void invoke("update_sticky_note_content", { id, content: latestTextRef.current }).catch(
      (err) => {
        console.error("保存便利贴失败:", err);
        // 磁盘满 / 内容超限（后端上限 10 万字符）等失败以前只打日志、用户零感知，
        // 以为已经存住了，刷新后内容回退甚至永久丢失。
        showNotice(`保存失败：${typeof err === "string" ? err : "请检查磁盘空间"}`);
      },
    );
  }, [showNotice]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushSave, 500);
  }, [flushSave]);

  // 原生关闭（Alt+F4）：后端把 WM_CLOSE 拦成「收起」并落 visible=false，
  // 这里只负责把防抖中（≤500ms）的正文立刻冲盘，避免随窗口隐藏一起丢。
  useEffect(() => {
    const unlisten = win.listen("sticky-note-close-requested", () => {
      flushSave();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [win, flushSave]);

  const onInput = () => {
    const text = readEditorText(editorRef.current);
    latestTextRef.current = text;
    setIsEmpty(text.trim().length === 0);
    scheduleSave();
    scheduleResize();
  };

  // 粘贴图片：阻止浏览器把图片塞成不可持久化的 <img>，改为逐张落盘后再以
  // 令牌式 <img data-note-img> 插入，随正文一并持久化。剪贴板可能含多张图，
  // 也可能同时含文本（如富文本网页里复制“文字+图片”）；此时需一并保留文本，
  // 否则整段 preventDefault 会静默丢弃随图文字。
  const onPaste = (event: React.ClipboardEvent) => {
    const clipboardData = event.clipboardData;
    const items = clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    event.preventDefault();
    const text = clipboardData?.getData("text/plain") ?? "";
    const editor = editorRef.current;
    if (editor && text) {
      // 先插入文本并把光标移到文本之后，随后 insertImages 的光标插入会接在文本后面
      insertAtCaret(editor, editor.ownerDocument.createTextNode(text));
    }
    void insertImages(files);
  };

  const insertAtCaret = (editor: HTMLElement, node: Node) => {
    const sel = editor.ownerDocument.getSelection();
    if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(node);
    }
  };

  const insertImages = async (files: File[]) => {
    for (const file of files) {
      await insertImage(file);
    }
  };

  const insertImage = async (file: File) => {
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < buffer.length; i += chunkSize) {
        binary += String.fromCharCode(...buffer.subarray(i, i + chunkSize));
      }
      const rel = await invoke<string>("save_sticky_note_image", {
        noteId: noteIdRef.current,
        base64Data: btoa(binary),
      });
      const editor = editorRef.current;
      if (!editor) return;
      // 目录未就绪时 src 留空（图片隐藏），由补图 effect 在目录到达后填充
      const dir = imagesDirRef.current;
      const img = createNoteImage(
        editor.ownerDocument,
        rel,
        dir ? convertFileSrc(`${dir}/${rel}`) : "",
        () => scheduleResize(),
      );
      insertAtCaret(editor, img);
      onInput();
    } catch (err) {
      console.error("保存便利贴图片失败:", err);
      // 粘贴已被 preventDefault，失败会静默丢失图片；给用户可见的短暂提示，避免无感知丢失。
      const detail =
        typeof err === "string" ? err : (err as { message?: string })?.message || "请重试";
      showNotice(`图片保存失败：${detail}`);
    }
  };

  // 组件卸载前把未保存内容落盘
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      if (positionTimerRef.current) window.clearTimeout(positionTimerRef.current);
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
      if (pasteErrorTimer.current) window.clearTimeout(pasteErrorTimer.current);
      if (!destroyedRef.current && hydratedRef.current) flushSave();
    };
  }, [flushSave]);

  // 拖拽结束/移动期间回写位置（防抖）
  useEffect(() => {
    const unlistenPromise = win.onMoved(async () => {
      if (positionTimerRef.current) window.clearTimeout(positionTimerRef.current);
      positionTimerRef.current = window.setTimeout(async () => {
        positionTimerRef.current = null;
        try {
          const pos = await win.outerPosition();
          void invoke("set_sticky_note_position", {
            id: noteIdRef.current,
            x: pos.x,
            y: pos.y,
          }).catch(() => {});
        } catch {
          /* 忽略位置读取失败 */
        }
      }, 250);
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [win]);

  /**
   * 按住便签的空白处拖动整窗。
   *
   * 判定挂在**窗口根节点**上，而不是只挂顶栏：顶栏只有 32px 高、且大半宽度被纸色点
   * 占掉，用户按到纸色点、正文、或卡片外那一圈留白上都以为「便利贴拖不动」。
   * 现在除了两类元素，窗口内任何位置都能拖：
   * - `button`：纸色点 / 收起 / 新建 / 删除都是点击目标，不能被拖拽吃掉；
   * - `.sn-editor`：正文是 contenteditable，按住要能落光标、划选文字。
   *
   * 用显式 startDragging()（而非 data-tauri-drag-region 属性）：后者由 Tauri 在
   * mousedown 时调 `internal_toggle_maximize` 处理双击，会把这张固定宽度的小纸条
   * 双击顶成整屏；这里只要拖拽，不要最大化。失败要出声——静默吞掉异常时，
   * 「拖不动」在日志里查不到任何痕迹。
   */
  const startNoteDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button") || target.closest(".sn-editor")) return;
    event.preventDefault();
    win.startDragging().catch((err) => console.error("拖动便利贴失败:", err));
  };

  const changeColor = (next: string) => {
    setColorId(next);
    void invoke("update_sticky_note_color", { id: noteIdRef.current, colorId: next }).catch((err) =>
      console.error("更换便利贴颜色失败:", err),
    );
  };

  const collect = () => {
    destroyedRef.current = true;
    // 携带最新正文落盘，避免防抖保存尚未触发窗口即被销毁而丢字
    void invoke("collect_sticky_note", {
      id: noteIdRef.current,
      content: latestTextRef.current,
    }).catch(() => {});
  };

  const addNew = async () => {
    try {
      const pos = await win.outerPosition();
      void invoke("create_sticky_note", {
        colorId: colorId,
        x: pos.x + 36,
        y: pos.y + 36,
      }).catch((err) => console.error("新建便利贴失败:", err));
    } catch {
      void invoke("create_sticky_note", { colorId }).catch((err) =>
        console.error("新建便利贴失败:", err),
      );
    }
  };

  const toggleDelete = () => {
    if (confirmDelete) {
      destroyedRef.current = true;
      void invoke("delete_sticky_note", { id: noteIdRef.current }).catch(() => {});
      return;
    }
    setConfirmDelete(true);
    if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = window.setTimeout(() => setConfirmDelete(false), 3000);
  };

  const paperStyle = {
    "--sn-paper": color.swatch,
    "--sn-paper-deep": color.fold,
  } as CSSProperties;

  if (!note) {
    // 内容读取中：保持窗口透明不闪烁。
    // 读取失败（便签确实还在）时给一个可操作的小卡片：否则这张便签会永远停在
    // 「看不见内容的空窗」状态，用户既看不到内容、也不知道发生了什么。
    if (!loadFailed) {
      return <div ref={rootRef} className="sn-window" data-loading="true" />;
    }
    return (
      <div ref={rootRef} className="sn-window" onMouseDown={startNoteDrag}>
        <article className="sn-card is-empty" style={paperStyle}>
          <div className="sn-paste-error" role="alert">
            读取便利贴失败，内容暂未加载
          </div>
          <div className="sn-load-retry">
            <button className="sn-btn" onClick={() => void loadNote()}>
              重试
            </button>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="sn-window" onMouseDown={startNoteDrag}>
      <article
        className={`sn-card ${isEmpty ? "is-empty" : ""} ${confirmDelete ? "is-deleting" : ""}`}
        style={paperStyle}
      >
        <header className="sn-head">
          {/* 常显的六点抓手：把「按住这里能拖动」说出来（真正的拖拽面是整个窗口） */}
          <span className="sn-grip" aria-hidden="true" />
          <div className="sn-colors">
            {NOTE_COLORS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sn-color-dot ${item.id === colorId ? "is-active" : ""}`}
                style={{ backgroundColor: item.swatch }}
                title={item.label}
                aria-label={`纸色：${item.label}`}
                aria-pressed={item.id === colorId}
                onClick={(event) => {
                  event.stopPropagation();
                  changeColor(item.id);
                }}
              />
            ))}
          </div>
          <span className="sn-head-spacer" />
          <button
            type="button"
            className="sn-btn sn-collect"
            title="收起（内容保留，可在管理窗重新打开）"
            aria-label="收起便利贴"
            onClick={collect}
          >
            <Icon name="X" size={14} />
          </button>
        </header>

        {pasteError && (
          <div className="sn-paste-error" role="alert">
            {pasteError}
          </div>
        )}

        <div className="sn-body">
          <div
            ref={editorRef}
            className="sn-editor"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline
            aria-label="便利贴内容"
            data-placeholder="写点什么，双击或点击即可编辑…"
            onInput={onInput}
            onPaste={onPaste}
            onBlur={flushSave}
            onKeyDown={(event) => {
              // Esc 收起
              if (event.key === "Escape") {
                event.preventDefault();
                (event.target as HTMLElement).blur();
                collect();
              }
            }}
          />
        </div>

        <footer className="sn-foot">
          <button
            type="button"
            className="sn-btn sn-add"
            title="在附近新建一张便利贴"
            aria-label="新建便利贴"
            onClick={addNew}
          >
            <Icon name="Plus" size={15} />
          </button>
          <span className="sn-foot-hint">
            {confirmDelete ? "再点一次确认删除" : "按住空白处可拖动 · Esc 收起"}
          </span>
          <button
            type="button"
            className={`sn-btn sn-delete ${confirmDelete ? "is-confirm" : ""}`}
            title="删除这张便利贴"
            aria-label="删除便利贴"
            onClick={toggleDelete}
          >
            <Icon name="Trash2" size={14} />
          </button>
        </footer>
      </article>
    </div>
  );
}

export default StickyNote;
