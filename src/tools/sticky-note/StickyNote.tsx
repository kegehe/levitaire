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
  clampWindowSize,
  getNoteColor,
  IMAGE_FILE_PATTERN,
  IMG_TOKEN_PATTERN,
  isNoteImgRel,
  manualSizeOf,
  NOTE_COLORS,
  NOTE_WIDTH,
  parseNoteIdFromLabel,
} from "./constants";
import { setContextMenuInterceptor } from "../../utils/desktopShell";
import { showAppMenu } from "../../utils/textContextMenu";
import { clampWindowToWorkArea } from "../../utils/panelWindow";
import "./StickyNote.css";

/**
 * 我们自己下发 `setSize`（或系统按新缩放重排窗口）后，多久之内到达的 resize 事件算
 * 「回声」而不是用户拖的。
 *
 * `onResized` 分不清「用户拖窗口边 / 拖手柄」与「前端按内容量高后 setSize」——两者都触发。
 * 自动高度模式下若不排除回声，每次内容变高都会被误判成「用户改过尺寸」，
 * 从此再也回不到自动高度。做法与后端 `position_save_suppress` 同一思路。
 *
 * 同一只窗口也用来盖住**跨显示器时的系统重排**（见 `onScaleChanged` 那个 effect）。
 *
 * 导出是给用例用的：那条路径要"等抑制窗口过期后再发 resize"，用字面量写死 400 会在
 * 这个值被调整时静默失准（用例还在等 400，窗口已经变成别的值）。
 */
export const PROGRAMMATIC_RESIZE_SUPPRESS_MS = 400;
/** 尺寸落盘与位置夹取的防抖（拖拽过程会连续触发 onResized） */
const SIZE_PERSIST_DEBOUNCE_MS = 250;

/**
 * 这次原生 resize 报回来的尺寸，是不是**我们自己刚下发的自动高度**（而不是用户拖的）。
 *
 * 自动模式的目标尺寸是已知的：宽恒为 `NOTE_WIDTH`、高恒为 `expectedHeight`（上一次量内容
 * 下发的高度）。逻辑尺寸与目标一致就说明这次变化不是用户拖出来的，可能是：
 * ① 迟到的回声（我们 setSize 后系统报回来的那次，`PROGRAMMATIC_RESIZE_SUPPRESS_MS` 只兜住
 *    400ms 内的，系统慢一拍就漏出来了）；
 * ② 把便签拖到另一台缩放不同的显示器上 —— 系统按新缩放重排窗口，**物理尺寸变了、逻辑尺寸
 *    没变**（这种情况只看物理值根本分不出来）；
 * ③ 后端在 show 之前按记忆尺寸摆位带来的那次缩放。
 *
 * 任其被当成「用户改过尺寸」，后果是永久切进手动模式：`scheduleResize()` 从此直接 return，
 * 自动高度再也回不来，用户只能双击右下角纸角手动复位。
 *
 * 纯函数（同 `caretBarGeometry`）：这类判定在 happy-dom 里量不到任何真实几何，只有把口径
 * 抽出来才能用用例钉住。容差 1px 是为了对齐取整误差；用户真拖了 1px 以内也等于没改。
 */
export function isAutoSizeEcho(
  logicalWidth: number,
  logicalHeight: number,
  expectedHeight: number,
): boolean {
  // 还没量过内容（目标高度未知）时没有可比的目标，一律按用户操作处理
  if (!(expectedHeight > 0)) return false;
  return Math.abs(logicalWidth - NOTE_WIDTH) <= 1 && Math.abs(logicalHeight - expectedHeight) <= 1;
}

/**
 * 粘贴时接管保存的图片 MIME。
 *
 * 与后端 `image` 依赖开启的特性（png/gif/jpeg/bmp，见 Cargo.toml）对应：
 * 只有这些格式能落盘成 PNG。
 *
 * 不在表里的图片类型（`image/svg+xml`、没开 webp 特性的 `image/webp` …）**要接管但落不下来**：
 * 见 `onPaste` —— 接管并说明原因，比放给浏览器插一张存不下的 `<img>` 好。
 */
const PASTABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/bmp",
]);

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
  /** 手动尺寸（原生窗口逻辑 px）。0 = 自动：宽 264、高随内容 */
  width: number;
  height: number;
  updatedAt?: string;
}

/** 把未知错误转成给用户看的短句（后端命令返回的就是字符串） */
function errorDetail(error: unknown): string {
  if (typeof error === "string" && error) return error;
  const message = (error as { message?: string } | null)?.message;
  return message && message.length > 0 ? message : "请重试";
}

/** 取节点里的便签图片（<img data-note-img>），其它节点返回 null */
function asNoteImage(node: Node | null | undefined): HTMLImageElement | null {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as HTMLElement;
  return element.tagName === "IMG" && element.hasAttribute("data-note-img")
    ? (element as HTMLImageElement)
    : null;
}

/**
 * 光标（折叠选区）**紧邻**的便签图片。
 *
 * 「紧邻」只认两种落点：图片之后、图片之前 —— 也就是用户点了一下图片、或把光标
 * 移到图片那一行两端时的位置。光标在正文段落里时返回 null（此时不该有图片光标条）。
 */
export function caretAdjacentImage(editor: HTMLElement | null): HTMLImageElement | null {
  if (!editor) return null;
  const selection = editor.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (!editor.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    const length = text.textContent?.length ?? 0;
    // 文本中间的位置不算图片行，只看两端
    const before = range.startOffset === 0 ? text.previousSibling : null;
    const after = range.startOffset === length ? text.nextSibling : null;
    return asNoteImage(before) ?? asNoteImage(after);
  }
  const children = node.childNodes;
  const before = children[range.startOffset - 1] ?? null;
  const after = children[range.startOffset] ?? null;
  return asNoteImage(before) ?? asNoteImage(after);
}

/**
 * 把光标放到图片**之后**（点图片的语义）。
 *
 * 不用浏览器默认的「按坐标猜一个位置」：图片是行内块，点在图片右半边时默认落点会在
 * 图片里/图片前后飘。固定落到图片之后，用户接着打字就是写在图片下面一行。
 */
export function placeCaretAfterImage(img: HTMLImageElement): boolean {
  const editor = img.parentElement;
  if (!editor) return false;
  editor.focus();
  try {
    const range = editor.ownerDocument.createRange();
    range.setStartAfter(img);
    range.collapse(true);
    const selection = editor.ownerDocument.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    // happy-dom 等环境缺少 Range.setStartAfter：光标定位是增强项，失败不该中断点击
    return false;
  }
}

/**
 * 图片行光标条与图片右边缘之间的间距（px）。
 *
 * 画在**外侧**而不是贴着边缘内侧：图片通常占满正文宽度，贴内侧时这根条正好压在图片自己的
 * 边界上，看起来像「图片右边框变粗了」；外侧仍有 `.sn-body` 的 12px 内边距可用，
 * 也不会被 `.sn-card` 的 overflow 裁掉。
 */
const CARET_BAR_GAP = 3;

/**
 * 由「图片矩形」与「正文可视区矩形」（都是视口坐标）算出图片行光标条的位置与高度。
 *
 * 纯函数，便于把这类几何一次钉死 —— DOM 里量出来的坐标一旦算错，表现是「条飘到别处」，
 * 而 happy-dom 的 `getBoundingClientRect()` 恒为 0，只有纯函数版本能在用例里覆盖。
 *
 * 三条口径：
 * 1. 高度取图片与可视区**相交**的那一段，所以图片滚出视口时条会被裁短、直至完全消失；
 * 2. 完全不可见（相交 ≤1px）返回 null；
 * 3. 坐标相对可视区左上角（这根条挂在**不滚动**的 `.sn-editor-wrap` 上，不要再补 scrollTop）。
 */
export function caretBarGeometry(
  imgRect: { top: number; bottom: number; right: number },
  wrapRect: { top: number; bottom: number; left: number },
): { left: number; top: number; height: number } | null {
  const top = Math.max(imgRect.top, wrapRect.top);
  const bottom = Math.min(imgRect.bottom, wrapRect.bottom);
  if (bottom - top <= 1) return null;
  return {
    left: imgRect.right - wrapRect.left + CARET_BAR_GAP,
    top: top - wrapRect.top,
    height: bottom - top,
  };
}

/** 在光标处插入一个节点（并把光标移到节点之后）；没有有效选区时追加到正文末尾 */
function insertAtCaret(editor: HTMLElement, node: Node): void {
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
  /**
   * 手动尺寸模式：用户拖过右下角手柄 / 窗口边之后为 true。
   *
   * - state 驱动 DOM（`data-manual` → 卡片撑满窗口、正文吃满剩余高度）；
   * - ref 是**立即生效**的模式位，给定时器回调与原生事件回调读 —— 那些路径读 state 只会
   *   拿到闭包里的旧值（auto 时长按拖拽会被后续的「按内容量高」打回去）。
   *
   * 尺寸**数值不进 state**：手动模式下布局靠 `height: 100%` 跟着窗口走，数值只在落盘时用；
   * 放进 state 会让每一次原生 resize 事件（拖拽时 ~60 次/秒）都重渲染一遍组件。
   */
  const [manualMode, setManualMode] = useState(false);
  const manualModeRef = useRef(false);
  /** 最近一次原生 resize 报回来的物理尺寸（拖拽期间高频刷新），落盘时再换算成逻辑尺寸 */
  const lastPhysicalSizeRef = useRef<{ width: number; height: number } | null>(null);
  /**
   * 缓存的窗口缩放系数：`onResized` 的 payload 是**物理**像素，要判断「是不是我们自己下发的
   * 那次尺寸」必须换算成逻辑像素再比（见 `isAutoSizeEcho`）。每次 resize 都去问 `scaleFactor()`
   * 就是 IPC 洪泛（拖拽时 ~60 次/秒），所以只在挂载时读一次、之后在落盘防抖里顺手刷新。
   */
  const scaleRef = useRef(1);

  const editorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretBarRef = useRef<HTMLDivElement>(null);
  /**
   * 窗口（OS 级）是否处于激活状态。失焦后浏览器不画原生光标，自绘的图片行光标条也得跟着收起；
   * 而 `document.activeElement` 在失焦时**不会**从正文上摘掉，所以必须单独记一位。
   */
  const windowFocusedRef = useRef(true);
  const latestTextRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const lastHeightRef = useRef(0);
  const positionTimerRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);
  const destroyedRef = useRef(false);
  /** 我们刚下发过 setSize 的时刻；此刻到期的 resize 事件是回声，不当用户操作处理 */
  const programmaticResizeUntilRef = useRef(0);
  const sizeSaveTimerRef = useRef<number | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "error" | "ok" } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  /**
   * 统一的短暂提示（原有的内联提示条，错误的久一点、成功的短一点）。
   * 粘贴图片、保存正文、读取便签、复制/删除图片、保存尺寸都走它 —— 这些路径以前只
   * `console.error`，用户零感知：以为已经存住了，刷新后内容却回退甚至丢失。
   */
  const showNotice = useCallback((text: string, tone: "error" | "ok" = "error") => {
    setNotice({ text, tone });
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), tone === "ok" ? 1800 : 3500);
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
      // 手动尺寸：窗口尺寸由后端在 show 之前就设好了，这里只需要让布局切到「撑满窗口」。
      // 判定沿用 constants 里的 manualSizeOf（0 / 缺省 / 脏值一律算自动），别在这里另写一套。
      const manual = manualSizeOf(data.width, data.height) !== null;
      applyManualMode(manual);
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

  // 缩放系数：挂载时读一次，之后**由 `onScaleChanged` 续上**。
  //
  // 为什么必须订阅、而不能只靠 `persistManualSize` 顺手刷新：窗口被拖到另一台缩放不同的
  // 显示器时，系统按「**逻辑尺寸不变、物理尺寸按新缩放重排**」重算窗口（tao 的
  // WM_DPICHANGED 就是这么做的）。而这份缓存是"把 `onResized` 的**物理** payload 除回
  // 逻辑尺寸"的唯一依据 —— 那一刻若还拿着旧缩放，264 宽的窗口会被算成 528 宽，
  // `isAutoSizeEcho` 判定失败 ⇒ 被判成"用户拖过窗口" ⇒ 静默退出自动高度并落盘。
  // 而 `persistManualSize` 只在**切进手动模式之后**才跑，那时候已经晚了。
  //
  // 读不到就按 1 算：宁可判定保守，也不要卡住。
  useEffect(() => {
    void win
      .scaleFactor()
      .then((scale) => {
        if (scale > 0) scaleRef.current = scale;
      })
      .catch(() => {});
    const unlisten = win.onScaleChanged(({ payload }) => {
      const scale = payload?.scaleFactor;
      if (typeof scale !== "number" || !(scale > 0)) return;
      scaleRef.current = scale;
      // 缩放变化**必然**伴随一次系统重排窗口，那次 resize 与"我们自己 setSize 的回声"
      // 是同一回事：都不是用户改的尺寸。手动模式下同样要挡 —— 跨屏重排后的尺寸不是用户
      // 拖出来的，落盘只会把记忆尺寸改坏。
      programmaticResizeUntilRef.current = Date.now() + PROGRAMMATIC_RESIZE_SUPPRESS_MS;
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [win]);

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

  /**
   * 把当前窗口夹回所在显示器的工作区（尺寸用**刚下发/刚变成**的逻辑尺寸）。
   *
   * 两个调用点都收在这一处：
   * ① 自动高度量完内容下发 `setSize` 之后 —— 便签越写越高，贴着屏幕下沿的便签不夹的话
   *    底部几行会落到工作区外；
   * ② 用户手动拖完尺寸之后 —— 往下拉高会把右下角手柄一起带出工作区，用户就再也够不到它。
   *
   * 集中在同一个函数里，`windowInstanceGuard` 才能继续用「setSize 与 clamp 数量对齐」
   * 的方式拦住「新增了一条 setSize 路径却忘了夹」。
   */
  const clampToWorkArea = useCallback((width: number, height: number) => {
    clampWindowToWorkArea(width, height);
  }, []);

  /**
   * 内容高度自适应：测量外层高度并调整窗口高度（宽度固定）。
   *
   * 手动尺寸模式下**直接跳过**：用户拖出来的高度就是用户要的高度，再按内容量一次
   * 就会把他刚调好的窗口打回原形。回到自动高度走 `resetSize()`。
   *
   * `force`：双击手柄复位时用 —— 复位前 `lastHeightRef` 记的可能正好等于当前内容高度，
   * 不强制的话「高度没变」这条守卫会把这次必要的 setSize 吞掉，窗口停在手动尺寸上。
   */
  const scheduleResize = useCallback(
    (force = false) => {
      if (manualModeRef.current) return;
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        const root = rootRef.current;
        if (!root) return;
        // 再挡一次手动模式：定时器是在**取消防抖之前**排上的，用户可能在这 40ms 里
        // 开始拖手柄 → 那次「按内容量高」会把刚拖出来的尺寸打回去。
        if (manualModeRef.current) return;
        const height = Math.ceil(root.offsetHeight);
        if (height > 0 && (force || height !== lastHeightRef.current)) {
          lastHeightRef.current = height;
          // 标记这次 setSize 是程序性的：紧随其后的 onResized 是回声，不是用户拖的
          programmaticResizeUntilRef.current = Date.now() + PROGRAMMATIC_RESIZE_SUPPRESS_MS;
          win.setSize(new LogicalSize(NOTE_WIDTH, height)).catch(() => {});
          // 便签越写越高：贴着屏幕下沿的便签若不重新夹，底部几行会落到工作区外。
          clampToWorkArea(NOTE_WIDTH, height);
        }
      }, 40);
    },
    [clampToWorkArea],
  );

  /**
   * 提示条出现在卡片中部（header 与正文之间），会把 footer 与右下角纸角手柄一起往下推
   * ~30px；提示条消失时又推回去。自动模式下窗口高度是**量内容量出来的**，不重新量就会把
   * 底部那几行裁在窗口外面（窗口不会滚动）—— 用户刚触发的提示自己把「删除 / 新建 / 改大小」
   * 三个入口顶出可见区。手动模式下 `scheduleResize` 自己会 return，无须在这里判断。
   */
  useEffect(() => {
    scheduleResize();
  }, [notice, scheduleResize]);

  /**
   * 手动尺寸模式位的**唯一写入口**：state（驱动 DOM 的 `data-manual`）与 ref（立即生效，
   * 供定时器回调 / 原生事件回调读）必须一起写。
   *
   * 漏一个的后果是静默的：只写 state 的话，40ms 后的「按内容量高」读到的仍是旧 ref，
   * 会把用户刚拖出来的窗口打回去。同一约定见总纲第 12 条（`commitConfig` / `applyMonitorWorkArea`）。
   */
  const applyManualMode = useCallback((on: boolean) => {
    manualModeRef.current = on;
    setManualMode(on);
  }, []);

  /**
   * 判定「窗口是真实存在的手动尺寸窗」并切进手动模式（读不到窗口尺寸返回 false）。
   *
   * 只有读取失败的分支用它：那时便签数据拿不到（`note` 为 null），但窗口尺寸就是真相 ——
   * 手动尺寸的便签（窗口已是记忆尺寸）若不切进手动模式，重试卡片会是几十像素高的一小条，
   * 下面一大片透明；切了才撑满窗口。这里**不落盘**（只影响布局口径，不改用户存的数据）。
   */
  const adoptManualModeFromWindow = useCallback(async (): Promise<boolean> => {
    try {
      const size = await win.innerSize();
      if (!size || size.width <= 0 || size.height <= 0) return false;
      applyManualMode(true);
      return true;
    } catch {
      return false;
    }
  }, [applyManualMode, win]);

  // 读取失败的卡片：先按「窗口是多大就撑多大」渲染，读不到窗口尺寸才退回自动高度量一次。
  // （自动高度那条路不能先跑：手动尺寸的便签会被它按「重试卡片」的内容量高，直接缩小窗口。）
  useEffect(() => {
    if (!loadFailed) return;
    let cancelled = false;
    void (async () => {
      const adopted = await adoptManualModeFromWindow();
      if (!cancelled && !adopted) scheduleResize();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFailed, adoptManualModeFromWindow, scheduleResize]);

  /**
   * 把「用户拖出来的尺寸」落盘（防抖）。
   *
   * 尺寸取的是 `onResized` payload 里那个**物理尺寸**，但物理 → 逻辑需要 scale factor，
   * 而 scale 只在窗口换了显示器（不同缩放）时才变 —— 所以换算推迟到防抖回调里做一次，
   * 拖拽期间一个 IPC 都不发（早期写法是每个 resize 事件都 `innerSize()` + `scaleFactor()`，
   * 60 次/秒的窗口事件就是 120 次 IPC/秒，而且异步结果还可能乱序落地）。
   */
  const persistManualSize = useCallback(() => {
    if (sizeSaveTimerRef.current) window.clearTimeout(sizeSaveTimerRef.current);
    sizeSaveTimerRef.current = window.setTimeout(() => {
      sizeSaveTimerRef.current = null;
      const physical = lastPhysicalSizeRef.current;
      if (!physical) return;
      void (async () => {
        let scale = 1;
        try {
          scale = (await win.scaleFactor()) || 1;
        } catch {
          /* 读不到就按 1 算：尺寸偏大也远好过不落盘 */
        }
        // 顺手刷新缓存：`onScaleChanged` 已经会维护它，这里只是兜底
        //（事件漏了或早于监听注册时，落盘这一刻至少用的是当下真实的缩放）。
        if (scale > 0) scaleRef.current = scale;
        const size = clampWindowSize(physical.width / scale, physical.height / scale);
        void invoke("set_sticky_note_size", {
          id: noteIdRef.current,
          width: size.width,
          height: size.height,
        }).catch((err) => {
          console.error("保存便利贴尺寸失败:", err);
          showNotice(`尺寸保存失败：${errorDetail(err)}`);
        });
        // 往下拉高的便签会把右下角手柄一起带出工作区，之后用户就够不到它了。
        // 拖拽结束后夹一次位置（拖的过程中不夹，免得和用户的手较劲）。
        clampToWorkArea(size.width, size.height);
      })();
    }, SIZE_PERSIST_DEBOUNCE_MS);
  }, [clampToWorkArea, showNotice, win]);

  /** 双击右下角手柄：回到「宽 264 + 高度随内容」的自动模式 */
  const resetSize = useCallback(() => {
    applyManualMode(false);
    // 丢掉拖拽期间的读数：防抖回调若赶在这次复位之后触发，会把手动尺寸又写回去
    lastPhysicalSizeRef.current = null;
    if (sizeSaveTimerRef.current) {
      window.clearTimeout(sizeSaveTimerRef.current);
      sizeSaveTimerRef.current = null;
    }
    void invoke("reset_sticky_note_size", { id: noteIdRef.current }).catch((err) => {
      console.error("恢复自动高度失败:", err);
      showNotice(`恢复自动高度失败：${errorDetail(err)}`);
    });
    // 立刻按内容重量一次：这一次也会把宽度带回到 NOTE_WIDTH（尺寸口径是**整窗**，见
    // scheduleResize）。高度在这次量出来是准的 —— 自动模式下 `.sn-window` 的宽度被 CSS
    // 钉死 264，量与窗口当时的宽度无关；否则按「还宽着的窗口」量出的高度在切回 264
    // 之后文字要多换行，底部会被裁掉一截（`force` 见 scheduleResize 的说明）。
    scheduleResize(true);
  }, [scheduleResize, showNotice]);

  /** 右下角手柄按下：交给原生缩放循环（窗口边缘那一圈由系统边框命中区负责） */
  const startResize = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      // 双击的第二下不要再去开原生缩放循环：手柄的双击语义是「回到自动高度」，
      // 若第二下也进了 resize 模态循环，dblclick 可能收不到。
      if (event.detail > 1) return;
      event.preventDefault();
      event.stopPropagation();
      win.startResizeDragging("SouthEast").catch((err) => {
        console.error("调整便利贴大小失败:", err);
        // 给一条**确定可用**的退路：双击纸角回自动高度（别再指向「拖窗口边缘」——
        // 无边框窗四边有没有原生命中区还没在真机上确认过，见 ensure_note_window 的注释）
        showNotice("调整大小失败，可双击纸角恢复自动高度");
      });
    },
    [win, showNotice],
  );

  /**
   * 用户拖动窗口边缘 / 手柄后：切进手动尺寸模式并落盘。
   *
   * 尺寸直接取事件 payload（Tauri 的 `WindowEvent::Resized` 带的就是新的物理尺寸），
   * 不再回读 `innerSize()`：一是省一次 IPC，二是避免异步回读乱序（拖拽时事件密，
   * 后发的读可能先返回，把中间尺寸当成最终尺寸落盘）。
   *
   * 必须排除我们自己 setSize 引起的回声（见 PROGRAMMATIC_RESIZE_SUPPRESS_MS）：
   * 自动高度每次内容变高都会 setSize，误判成「用户改过尺寸」后就再也回不到自动高度。
   */
  useEffect(() => {
    const unlisten = win.onResized(({ payload }) => {
      if (Date.now() < programmaticResizeUntilRef.current) return;
      if (!payload || payload.width <= 0 || payload.height <= 0) return;
      // 自动模式下再兜一道「尺寸没变就不算用户操作」：迟到的回声与「换显示器导致的物理尺寸
      // 变化」都落在这一条上（见 isAutoSizeEcho）。换显示器那次同时会被 `onScaleChanged`
      // 设下的抑制窗口挡住，两道一起才够 —— 只靠这里，缩放缓存一旦落后就会误判。
      // 手动模式下不挡 —— 那时窗口尺寸就是用户拖着走的，每次变化都要落盘。
      const scale = scaleRef.current || 1;
      if (
        !manualModeRef.current &&
        isAutoSizeEcho(payload.width / scale, payload.height / scale, lastHeightRef.current)
      ) {
        return;
      }
      lastPhysicalSizeRef.current = { width: payload.width, height: payload.height };
      applyManualMode(true);
      persistManualSize();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [win, applyManualMode, persistManualSize]);

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

  const onInput = useCallback(() => {
    const text = readEditorText(editorRef.current);
    latestTextRef.current = text;
    setIsEmpty(text.trim().length === 0);
    scheduleSave();
    scheduleResize();
  }, [scheduleSave, scheduleResize]);

  /**
   * 把一张**已经落盘**的便签图片插到光标处（粘贴 / 拖入共用一条通路）。
   * 目录未就绪时 src 留空（图片隐藏），由补图 effect 在目录到达后填充。
   */
  /**
   * 正文挂载前不让图片**落盘**。
   *
   * 读取中 / 读取失败态下 editor 还不存在，而后端一旦收到 import / save 就会把文件写进图片目录 ——
   * 插不进去的那张图从此变成孤儿（要等整张便签删除才清），而用户以为贴成功了。
   * 只有**拖入**这条入口需要它：粘贴的 handler 挂在正文元素上，正文不存在就收不到事件。
   * 提示只在这一处给，别在下面各写一句。
   */
  const ensureEditorReady = useCallback((): boolean => {
    if (editorRef.current) return true;
    showNotice("正文还没准备好，请稍后再试");
    return false;
  }, [showNotice]);

  /** 把一张**已经落盘**的便签图片插到光标处（粘贴 / 拖入共用一条通路） */
  const insertNoteImage = useCallback(
    (rel: string) => {
      const editor = editorRef.current;
      // 兜底（正常到不了这里：两个入口都先过了 ensureEditorReady）
      if (!editor) return;
      const dir = imagesDirRef.current;
      const img = createNoteImage(
        editor.ownerDocument,
        rel,
        dir ? convertFileSrc(`${dir}/${rel}`) : "",
        () => scheduleResize(),
      );
      insertAtCaret(editor, img);
      onInput();
    },
    [onInput, scheduleResize],
  );

  /**
   * 把外部拖入的图片文件导入便签：后端负责校验格式/体积并转码成 PNG 落盘，
   * 前端拿到令牌后照常插入。多张依次插入（顺序与拖入顺序一致）。
   */
  const insertImagePaths = useCallback(
    async (paths: string[]) => {
      if (!ensureEditorReady()) return;
      for (const path of paths) {
        try {
          const rel = await invoke<string>("import_sticky_note_image", {
            noteId: noteIdRef.current,
            path,
          });
          insertNoteImage(rel);
        } catch (err) {
          console.error("导入便利贴图片失败:", err);
          showNotice(`图片导入失败：${errorDetail(err)}`);
        }
      }
    },
    [ensureEditorReady, insertNoteImage, showNotice],
  );

  /**
   * 更新「图片行光标条」：光标紧邻某张图片时，在图片右侧画一根**与图片等高**的竖条，
   * 并把图片描边点亮 —— 让用户一眼看出「现在是在图片这一行」。
   *
   * 为什么自己画而不指望原生光标：Chromium 的光标高度跟的是字体度量（实测 14px 字号
   * 恒定 18px 高），图片再大也拉不高它；光标落在图片后、而图片后面又是换行时，浏览器
   * 还会把光标画到下一行行首。自己画一根与图片等高的竖条，语义上就等于「光标=图片高度」。
   */
  const syncImageCaret = useCallback(() => {
    const bar = caretBarRef.current;
    const editor = editorRef.current;
    if (!bar || !editor) return;
    const wrap = bar.parentElement;
    const active = editor.ownerDocument.activeElement;
    const focused = active instanceof Node && editor.contains(active);
    // ⚠️ 只看 DOM 焦点不够：窗口失去激活（用户点了别的窗口）时 WebView2 **不会**把
    // `document.activeElement` 从正文上摘掉，只凭上面那一句判定，失焦后这根自绘的条会
    // 一直留在纸上 —— 而浏览器连原生光标都不画了，看起来就是一根卡住的残影。
    const img = focused && windowFocusedRef.current ? caretAdjacentImage(editor) : null;
    editor
      .querySelectorAll("img[data-note-img].is-caret-line")
      .forEach((node) => node.classList.remove("is-caret-line"));
    if (!img || !wrap) {
      bar.dataset.visible = "false";
      return;
    }
    const imgRect = img.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    if (imgRect.height <= 0) {
      bar.dataset.visible = "false";
      return;
    }
    // 几何一律交给 caretBarGeometry（视口坐标相减、夹到可视区），别在这里就地算
    const geometry = caretBarGeometry(imgRect, wrapRect);
    if (!geometry) {
      bar.dataset.visible = "false";
      return;
    }
    img.classList.add("is-caret-line");
    bar.style.left = `${Math.round(geometry.left)}px`;
    bar.style.top = `${Math.round(geometry.top)}px`;
    bar.style.height = `${Math.round(geometry.height)}px`;
    bar.dataset.visible = "true";
  }, []);

  // 光标移动 / 正文滚动后重算光标条。selectionchange 覆盖「方向键、点击别处」这些
  // 不走 onInput 的路径；editor 只在 note 就绪后才挂载，所以依赖 note。
  // 窗口失焦时也要重算（收起来）：失焦后浏览器连原生光标都不画了，我们自己画的那根
  // 却会留在纸上，看着像卡住的残影 —— 状态记在 windowFocusedRef 里（DOM 焦点的判定
  // 在失焦时不会变，见 syncImageCaret）。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const doc = editor.ownerDocument;
    const handler = () => syncImageCaret();
    const onBlur = () => {
      windowFocusedRef.current = false;
      handler();
    };
    const onFocus = () => {
      windowFocusedRef.current = true;
      handler();
    };
    doc.addEventListener("selectionchange", handler);
    editor.addEventListener("scroll", handler);
    window.addEventListener("blur", onBlur);
    // 回来时也补一次：window 失焦不一定会把 DOM 选区清掉
    window.addEventListener("focus", onFocus);
    return () => {
      doc.removeEventListener("selectionchange", handler);
      editor.removeEventListener("scroll", handler);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [note, syncImageCaret]);

  /**
   * 点图片：把光标放到图片**之后**，并立即点亮图片行光标条。
   *
   * 顺手 preventDefault：不拦的话浏览器会按坐标在图片内部/前后猜一个落点，点在图片
   * 右半边时光标会飘到下一行行首，用户以为「点图片没反应」。这里固定落到图片后面，
   * 接着打字就是写在图片下面。
   */
  const onEditorMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    const img = target?.closest?.("img[data-note-img]") as HTMLImageElement | null;
    if (!img) return;
    event.preventDefault();
    event.stopPropagation();
    placeCaretAfterImage(img);
    syncImageCaret();
  };

  /** 右键图片：复制到系统剪贴板（不需要先选中图片） */
  const copyNoteImage = useCallback(
    (rel: string) => {
      void invoke("copy_sticky_note_image", { id: noteIdRef.current, rel })
        .then(() => showNotice("已复制图片", "ok"))
        .catch((err) => {
          console.error("复制便利贴图片失败:", err);
          showNotice(`复制失败：${errorDetail(err)}`);
        });
    },
    [showNotice],
  );

  /** 右键图片：从正文里删掉这张图，并删除磁盘文件 */
  const removeNoteImage = useCallback(
    (img: HTMLImageElement, rel: string) => {
      img.remove();
      onInput();
      syncImageCaret();
      void invoke("delete_sticky_note_image", { id: noteIdRef.current, rel }).catch((err) => {
        console.error("删除便利贴图片失败:", err);
        showNotice(`图片已从正文移除，但文件删除失败：${errorDetail(err)}`);
      });
    },
    [onInput, showNotice, syncImageCaret],
  );

  /**
   * 右键接管：图片上的右键换成「复制图片 / 删除图片」。
   *
   * 通用文本菜单在没有选中内容时「复制」是灰的 —— 而图片本来就选不中，用户想复制一张
   * 图片只能先框选它，这正是不好用的地方。这里在图片上直接把菜单换成图片语义。
   */
  useEffect(() => {
    setContextMenuInterceptor((event) => {
      const target = event.target as HTMLElement | null;
      const img = target?.closest?.("img[data-note-img]") as HTMLImageElement | null;
      if (!img) return false; // 交回通用文本菜单
      const rel = img.getAttribute("data-note-img");
      if (!rel) return false;
      showAppMenu(
        { x: event.clientX || 12, y: event.clientY || 12 },
        [
          { id: "copyImage", label: "复制图片", run: () => copyNoteImage(rel) },
          { id: "deleteImage", label: "删除图片", run: () => removeNoteImage(img, rel) },
        ],
        "图片",
      );
      return true;
    });
    return () => setContextMenuInterceptor(null);
  }, [copyNoteImage, removeNoteImage]);

  /**
   * 粘贴接管：位图逐张落盘后再以令牌式 <img> 插入（随正文一并持久化）。
   *
   * 剪贴板可能同时含文本（富文本网页里复制「文字 + 图片」），接管时要把文本自己补回去，
   * 否则一 `preventDefault` 就把随图文字静默丢掉。
   *
   * ⚠️ **落不下来的图片类型也必须接管**（`image/svg+xml`、未开 webp 特性的 webp …）：
   * 放给浏览器默认行为，它会插一张靠 `blob:` / `data:` 的 `<img>` —— 那种图片在正文里不落
   * 任何令牌（`serializeEditorText` 只认 `data-note-img`），于是用户看着图贴进来了、
   * 重新打开便签却没有，比「什么都不发生」更糟。接管 + 说明原因才是可解释的行为。
   */
  const onPaste = (event: React.ClipboardEvent) => {
    const clipboardData = event.clipboardData;
    const items = clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    const rejected = new Set<string>();
    for (const item of items) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (PASTABLE_IMAGE_TYPES.has(item.type)) files.push(file);
      // 只取子类型名做提示（image/svg+xml → SVG+XML 太长，用斜杠后那段）
      else rejected.add(item.type.slice("image/".length).toUpperCase());
    }
    if (files.length === 0 && rejected.size === 0) return;
    event.preventDefault();
    const text = clipboardData?.getData("text/plain") ?? "";
    const editor = editorRef.current;
    if (editor && text) {
      // 先插入文本并把光标移到文本之后，随后 insertImages 的光标插入会接在文本后面
      insertAtCaret(editor, editor.ownerDocument.createTextNode(text));
    }
    if (rejected.size > 0) {
      showNotice(`不支持的图片格式：${[...rejected].join(" / ")}（只支持 PNG / JPG / GIF / BMP）`);
    }
    if (files.length > 0) void insertImages(files);
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
      insertNoteImage(rel);
    } catch (err) {
      console.error("保存便利贴图片失败:", err);
      // 粘贴已被 preventDefault，失败会静默丢失图片；给用户可见的短暂提示，避免无感知丢失。
      showNotice(`图片保存失败：${errorDetail(err)}`);
    }
  };

  // 组件卸载前把未保存内容落盘
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      if (positionTimerRef.current) window.clearTimeout(positionTimerRef.current);
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
      if (sizeSaveTimerRef.current) window.clearTimeout(sizeSaveTimerRef.current);
      if (!destroyedRef.current && hydratedRef.current) flushSave();
    };
  }, [flushSave]);

  /**
   * 把图片文件从资源管理器拖进便签。
   *
   * 走 Tauri 的原生拖放事件（`tauri://drag-drop`）而不是 HTML5 drop：Windows 上
   * WebView2 的拖放被 Tauri 接管，页面根本收不到 HTML5 dragover/drop（这也是
   * settings 窗口要 `disable_drag_drop_handler()` 才能用 HTML5 拖拽排序的原因）。
   * 这里只需要文件路径，原生事件反而是更省事的一条路。
   */
  useEffect(() => {
    const unlisten = win.onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const images = event.payload.paths.filter((path) => IMAGE_FILE_PATTERN.test(path));
      if (images.length === 0) return;
      void insertImagePaths(images);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [win, insertImagePaths]);

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
   * 现在除了三类元素，窗口内任何位置都能拖：
   * - `button`：纸色点 / 收起 / 新建 / 删除都是点击目标，不能被拖拽吃掉；
   * - `.sn-editor`：正文是 contenteditable，按住要能落光标、划选文字；
   * - `.sn-resize`：右下角手柄要能拖出缩放（它自己会 stopPropagation，这里再挡一道，
   *   免得以后有人把手柄挪到不冒泡的位置）。
   *
   * 用显式 startDragging()（而非 data-tauri-drag-region 属性）：后者由 Tauri 在
   * mousedown 时调 `internal_toggle_maximize` 处理双击，会把这张固定宽度的小纸条
   * 双击顶成整屏；这里只要拖拽，不要最大化。失败要出声——静默吞掉异常时，
   * 「拖不动」在日志里查不到任何痕迹。
   */
  const startNoteDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button") || target.closest(".sn-editor") || target.closest(".sn-resize"))
      return;
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

  /**
   * 短暂提示条。**两个分支都要渲染**：读取失败态下图片导入 / 格式不支持这类提示同样要给 ——
   * 只放在主分支的话，这些「出声」的策略在失败态里就全静音了。
   */
  const noticeBar = notice ? (
    <div className={`sn-notice is-${notice.tone}`} role={notice.tone === "ok" ? "status" : "alert"}>
      {notice.text}
    </div>
  ) : null;

  if (!note) {
    // 内容读取中：保持窗口透明不闪烁。
    // 读取失败（便签确实还在）时给一个可操作的小卡片：否则这张便签会永远停在
    // 「看不见内容的空窗」状态，用户既看不到内容、也不知道发生了什么。
    if (!loadFailed) {
      return <div ref={rootRef} className="sn-window" data-loading="true" />;
    }
    return (
      <div
        ref={rootRef}
        className="sn-window"
        // 失败态也要带 data-manual：上面 `adoptManualModeFromWindow` 认下的手动模式必须落到
        // DOM 上，否则卡片只有几十像素高、下面一大片透明（模式认了却没生效，等于没修）
        data-manual={manualMode ? "true" : undefined}
        onMouseDown={startNoteDrag}
      >
        <article className="sn-card is-empty" style={paperStyle}>
          <div className="sn-notice is-error" role="alert">
            读取便利贴失败，内容暂未加载
          </div>
          {noticeBar}
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
    <div
      ref={rootRef}
      className="sn-window"
      // 手动尺寸：卡片撑满窗口、正文吃掉剩余高度（自动模式下窗口高度是量出来的）
      data-manual={manualMode ? "true" : undefined}
      onMouseDown={startNoteDrag}
    >
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

        {noticeBar}

        <div className="sn-body">
          <div className="sn-editor-wrap">
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
              // 点图片 = 把光标放到图片后面（图片整块都是命中区）
              onMouseDown={onEditorMouseDown}
              onMouseUp={syncImageCaret}
              onKeyUp={syncImageCaret}
              onBlur={() => {
                flushSave();
                syncImageCaret();
              }}
              onKeyDown={(event) => {
                // Esc 收起
                if (event.key === "Escape") {
                  event.preventDefault();
                  (event.target as HTMLElement).blur();
                  collect();
                }
              }}
            />
            {/* 光标紧邻图片时显示的「图片行光标条」：与图片等高，见 syncImageCaret */}
            <div ref={caretBarRef} className="sn-image-caret" aria-hidden="true" />
          </div>
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
            {confirmDelete ? "再点一次确认删除" : "空白处拖动 · 右下角改大小"}
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

        {/* 右下角纸角 = 拖拽改大小（双击恢复「高度随内容」） */}
        <div
          className="sn-resize"
          role="separator"
          tabIndex={-1}
          aria-label="拖拽调整便利贴大小，双击恢复自动高度"
          title="拖拽调整大小 · 双击恢复自动高度"
          onMouseDown={startResize}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            resetSize();
          }}
        />
      </article>
    </div>
  );
}

export default StickyNote;
