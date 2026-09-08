import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import { getNoteColor, NOTE_COLORS, parseNoteIdFromLabel } from "./constants";
import "./StickyNote.css";

/** 与后端 sticky_note::NOTE_WIDTH_LOGICAL 一致（逻辑像素） */
const NOTE_WIDTH = 264;

/** 块级标签：序列化时在这些元素之间补换行 */
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3"]);

/**
 * 把 contenteditable 的 DOM 序列化为纯文本。
 * 不用 innerText（happy-dom/部分环境不一致）：文本节点原样保留（配合
 * white-space: pre-wrap 渲染换行），块级元素之间补换行，<br> 视为换行。
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
  const [colorId, setColorId] = useState<string>("yellow");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);

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

  // 读取便签内容；已删除（如被管理窗删掉）时自毁窗口
  useEffect(() => {
    let disposed = false;
    const id = noteIdRef.current;
    invoke<StickyNote>("get_sticky_note", { id })
      .then((data) => {
        if (disposed) return;
        setNote(data);
        setColorId(data.colorId || "yellow");
      })
      .catch(() => {
        // 便利贴已不存在：关闭窗口
        void win.destroy().catch(() => {});
      });
    return () => {
      disposed = true;
    };
  }, []);

  // note 渲染完成后（editor 已挂载）再水合正文；不能在上面的 then 中直接写
  // editorRef——此时新分支尚未提交，ref 仍为 null。
  useEffect(() => {
    if (!note || hydratedRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    hydratedRef.current = true;
    editor.textContent = note.content;
    latestTextRef.current = note.content;
    setIsEmpty(note.content.trim().length === 0);
    scheduleResize();
  }, [note]);

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
      }
    }, 40);
  }, []);

  /** 保存正文（防抖） */
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (destroyedRef.current) return;
    const id = noteIdRef.current;
    void invoke("update_sticky_note_content", { id, content: latestTextRef.current }).catch(
      (err) => console.error("保存便利贴失败:", err),
    );
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushSave, 500);
  }, [flushSave]);

  const onInput = () => {
    const text = readEditorText(editorRef.current);
    latestTextRef.current = text;
    setIsEmpty(text.trim().length === 0);
    scheduleSave();
    scheduleResize();
  };

  // 组件卸载前把未保存内容落盘
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      if (positionTimerRef.current) window.clearTimeout(positionTimerRef.current);
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
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

  const startHeaderDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    win.startDragging().catch(() => {});
  };

  const changeColor = (next: string) => {
    setColorId(next);
    void invoke("update_sticky_note_color", { id: noteIdRef.current, colorId: next }).catch(
      (err) => console.error("更换便利贴颜色失败:", err),
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
    // 内容读取中：保持窗口透明不闪烁
    return <div ref={rootRef} className="sn-window" data-loading="true" />;
  }

  return (
    <div ref={rootRef} className="sn-window">
      <article
        className={`sn-card ${isEmpty ? "is-empty" : ""} ${confirmDelete ? "is-deleting" : ""}`}
        style={paperStyle}
      >
        <header className="sn-head" onMouseDown={startHeaderDrag}>
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
          <span className="sn-foot-hint">{confirmDelete ? "再点一次确认删除" : "拖动顶栏移动 · Esc 收起"}</span>
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
