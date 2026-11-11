import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import Icon from "../../components/Icon";
import ConfirmDialog from "../../components/ConfirmDialog";
import { clampWindowToWorkArea, panelWindowSize } from "../../utils/panelWindow";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import { formatBytes } from "../../utils/formatBytes";
import { moveItemToIndex } from "./order";
import "./FileShelf.css";

interface ShelfItem {
  id: string;
  kind: "reference" | "owned";
  name: string;
  isDir: boolean;
  size: number | null;
  addedAt: string;
  missing: boolean;
}

interface ShelfSnapshot {
  items: ShelfItem[];
  collapsed: boolean;
  notice: string | null;
}

interface AddResult {
  status: "added" | "topped" | "rejected" | "ignored";
  message?: string | null;
}

const PANEL_WIDTH = 320;

/* 磁贴尺寸（与 FileShelf.css 的 .file-shelf-grid / .file-card 对齐）：
   预览 64 + meta 48 + 边框 3 ≈ 116，行距 9；网格最多完整显示 3 行，其余滚动。 */
const TILE_HEIGHT = 116;
const GRID_ROW_GAP = 9;
const GRID_MAX_HEIGHT = 378;
/* 排序时贴着列表上下边缘拖动会自动滚动：进入边缘区后按距离加速 */
const REORDER_SCROLL_EDGE = 26;
const REORDER_SCROLL_MIN_SPEED = 260;
const REORDER_SCROLL_MAX_SPEED = 1160;
/* .file-shelf 自身的上下边框（border-box：内容区 = 面板高 - 2px），不算会被裁掉页脚 */
const SHELF_BORDER = 2;

function panelHeight(collapsed: boolean, count: number, extraLines: number): number {
  if (collapsed) return 36;
  const extra = extraLines * 36;
  if (count === 0) {
    // 空状态：头 44 + 虚线容器(2 + 118 + 10) + 底 38
    return Math.min(460 + extra, 212 + SHELF_BORDER + extra);
  }
  const rows = Math.ceil(count / 2);
  const gridHeight = Math.min(
    2 + rows * TILE_HEIGHT + (rows - 1) * GRID_ROW_GAP + 10,
    GRID_MAX_HEIGHT,
  );
  return Math.min(460 + extra, 44 + gridHeight + 38 + SHELF_BORDER + extra);
}

/* ---------- 按扩展名的类型体系（方案 S 精修：类型 → 图标 + 渐变底色） ---------- */

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
  "avif",
  "tif",
  "tiff",
]);
const VIDEO_EXTS = new Set([
  "mp4",
  "mkv",
  "mov",
  "avi",
  "webm",
  "m4v",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
  "ts",
  "3gp",
]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus", "wma"]);
const DOC_EXTS = new Set(["doc", "docx", "rtf", "odt", "pages"]);
const SHEET_EXTS = new Set(["xls", "xlsx", "csv", "ods", "numbers"]);
const SLIDE_EXTS = new Set(["ppt", "pptx", "odp", "key"]);
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
const CODE_EXTS = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "kt",
  "swift",
  "json",
  "html",
  "htm",
  "css",
  "scss",
  "vue",
  "svelte",
  "sh",
  "bat",
  "cmd",
  "ps1",
  "sql",
  "ipynb",
  "toml",
  "xml",
  "yml",
  "yaml",
]);
const TEXT_EXTS = new Set(["txt", "md", "markdown", "log", "ini", "cfg", "conf", "env"]);
const EXE_EXTS = new Set(["exe", "msi", "appx"]);
const FONT_EXTS = new Set(["ttf", "otf", "woff", "woff2"]);

function fileVisual(item: ShelfItem): { type: string; media: "image" | "video" | null } {
  if (item.isDir) return { type: "dir", media: null };
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  // svg 保持类型渐变：后端用 image crate 解码，栅格化不了矢量图，请求必然失败。
  if (IMAGE_EXTS.has(ext)) return { type: "img", media: ext === "svg" ? null : "image" };
  if (VIDEO_EXTS.has(ext)) return { type: "video", media: "video" };
  if (AUDIO_EXTS.has(ext)) return { type: "audio", media: null };
  if (ext === "pdf") return { type: "pdf", media: null };
  if (DOC_EXTS.has(ext)) return { type: "docx", media: null };
  if (SHEET_EXTS.has(ext)) return { type: "sheet", media: null };
  if (SLIDE_EXTS.has(ext)) return { type: "slide", media: null };
  if (ARCHIVE_EXTS.has(ext)) return { type: "archive", media: null };
  if (CODE_EXTS.has(ext)) return { type: "code", media: null };
  if (TEXT_EXTS.has(ext)) return { type: "text", media: null };
  if (EXE_EXTS.has(ext)) return { type: "exe", media: null };
  if (FONT_EXTS.has(ext)) return { type: "font", media: null };
  return { type: "file", media: null };
}

const ADDED_AT_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatAddedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return ADDED_AT_FORMAT.format(date);
}

/** 卡片 tooltip：文件名 + 大小/加入时间，鼠标悬停时补足卡片上放不下的信息。 */
function itemTooltip(item: ShelfItem): string {
  const size = item.isDir ? "文件夹" : item.size == null ? "" : formatBytes(item.size);
  const added = formatAddedAt(item.addedAt);
  const meta = [size, added ? `加入 ${added}` : ""].filter(Boolean).join(" · ");
  return meta ? `${item.name}\n${meta}` : item.name;
}

/* 带文字标签的文件图标（PDF/DOC/XLS/PPT/ZIP/EXE/TTF），其余类型用符号图标 */
const GLYPH_LABELS: Record<string, string> = {
  pdf: "PDF",
  docx: "DOC",
  sheet: "XLS",
  slide: "PPT",
  archive: "ZIP",
  exe: "EXE",
  font: "TTF",
};

function FileGlyph({ type }: { type: string }) {
  if (type === "dir") return <Icon name="FolderOpen" size={20} />;
  if (type === "img") return <Icon name="Image" size={20} />;
  if (type === "video") return <Icon name="Film" size={20} />;
  if (type === "audio") return <Icon name="Music" size={20} />;
  if (type === "code") return <Icon name="Code" size={20} />;
  if (type === "text") return <Icon name="FileText" size={20} />;
  if (type === "dead" || type === "file") return <Icon name="Download" size={20} />;
  const label = GLYPH_LABELS[type] ?? "FILE";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    >
      <path d="M14 2.5H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5z" />
      <path d="M14 2.5v6h6" />
      <text
        x="12"
        y="18"
        textAnchor="middle"
        fontSize="6.5"
        fontWeight="700"
        stroke="none"
        fill="currentColor"
        fontFamily="inherit"
      >
        {label}
      </text>
    </svg>
  );
}

function FileShelf() {
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // 「清空」的确认弹窗（替代原生 window.confirm）。ref 给 Ctrl+V 处理器做守卫用。
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const confirmClearOpenRef = useRef(false);
  confirmClearOpenRef.current = confirmClearOpen;
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // 系统拖放由后端的 IDropTarget 接管，页面收不到 dragover，只能听后端转发。
  // dragArmed：系统里有人开始拖文件了（还没到窗口上）；dragOver：光标已经到了窗口上。
  const [dragArmed, setDragArmed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 正在架内排序的条目 id。拖动卡片时：停在面板内是排序，移出面板才是拖出。
  const [reordering, setReordering] = useState<string | null>(null);
  const reorderingRef = useRef<string | null>(null);
  const itemsRef = useRef<ShelfItem[]>([]);
  const orderBeforeReorder = useRef<ShelfItem[] | null>(null);
  // 排序松手后浏览器仍可能补一个 click；不拦住会把刚拖过的卡片选中。
  const suppressClick = useRef(false);
  // Shift 连选的锚点按 id 记：排序后索引会变，但 id 不会丢。
  const selectionAnchor = useRef<string | null>(null);
  const shelfRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLUListElement | null>(null);
  const flipFrom = useRef<Map<string, DOMRect> | null>(null);
  // 排序时最近一次指针位置，自动滚动按它判断是否停在列表上下边缘。
  const reorderPointer = useRef<{ x: number; y: number } | null>(null);
  itemsRef.current = items;
  const collapsedRef = useRef(false);
  collapsedRef.current = collapsed;
  const jobs = useRef(Promise.resolve());
  const runExclusive = useCallback((job: () => Promise<void>) => {
    // 末尾接一个 catch：队列最后一环若 reject（例如应用退出时 shelf_list 失败），
    // 不接住会变成未处理拒绝。后续任务本来就会照常执行（then 的第二个参数）。
    jobs.current = jobs.current.then(job, job).catch(() => {});
  }, []);

  // 排序时先本地重排，再用 FLIP 给没被拖的卡片补一段位移，避免整盘格子瞬间跳位。
  const applyOrder = useCallback((next: ShelfItem[]) => {
    const grid = gridRef.current;
    if (grid) {
      const rects = new Map<string, DOMRect>();
      for (const card of Array.from(grid.children) as HTMLElement[]) {
        const id = card.dataset.shelfId;
        if (id) rects.set(id, card.getBoundingClientRect());
      }
      flipFrom.current = rects;
    }
    itemsRef.current = next;
    setItems(next);
  }, []);

  /** 光标最近的那一格。槽位由索引决定，重排时位置本身不动，按中心点距离取即可。 */
  const slotIndexAt = useCallback((x: number, y: number): number => {
    const grid = gridRef.current;
    if (!grid) return -1;
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    Array.from(grid.children).forEach((child, index) => {
      const rect = child.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }, []);

  useLayoutEffect(() => {
    const from = flipFrom.current;
    if (!from) return;
    flipFrom.current = null;
    const grid = gridRef.current;
    if (!grid) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const card of Array.from(grid.children) as HTMLElement[]) {
      const id = card.dataset.shelfId;
      if (!id || id === reorderingRef.current) continue;
      const before = from.get(id);
      if (!before) continue;
      const after = card.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx === 0 && dy === 0) continue;
      card.animate?.(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
        { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  }, [items]);

  // 排序时按住卡片停在列表上下边缘，列表会自动滚动，并把拖拽项继续往新的落点挪。
  useEffect(() => {
    if (!reordering) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = window.requestAnimationFrame(tick);
      const grid = gridRef.current;
      const pointer = reorderPointer.current;
      const id = reorderingRef.current;
      if (!grid || !pointer || !id) return;
      if (grid.scrollHeight <= grid.clientHeight) return;
      const rect = grid.getBoundingClientRect();
      if (pointer.y < rect.top || pointer.y > rect.bottom) {
        last = now;
        return;
      }
      const topIntensity = (rect.top + REORDER_SCROLL_EDGE - pointer.y) / REORDER_SCROLL_EDGE;
      const bottomIntensity =
        (pointer.y - (rect.bottom - REORDER_SCROLL_EDGE)) / REORDER_SCROLL_EDGE;
      const direction = topIntensity > 0 ? -1 : bottomIntensity > 0 ? 1 : 0;
      if (direction === 0) {
        last = now;
        return;
      }
      const intensity = Math.min(Math.max(topIntensity, bottomIntensity), 1);
      const dt = last === 0 ? 1 / 60 : Math.min((now - last) / 1000, 0.032);
      last = now;
      const before = grid.scrollTop;
      grid.scrollTop =
        before +
        direction *
          (REORDER_SCROLL_MIN_SPEED +
            (REORDER_SCROLL_MAX_SPEED - REORDER_SCROLL_MIN_SPEED) * intensity) *
          dt;
      if (grid.scrollTop === before) return;
      const index = slotIndexAt(pointer.x, pointer.y);
      if (index < 0) return;
      const next = moveItemToIndex(itemsRef.current, id, index);
      if (next) applyOrder(next);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [applyOrder, reordering, slotIndexAt]);

  const refresh = useCallback(async () => {
    const snapshot = await invoke<ShelfSnapshot>("shelf_list");
    setItems(snapshot.items);
    setCollapsed(snapshot.collapsed);
    if (snapshot.notice) setNotice(snapshot.notice);
    setSelected((current) => current.filter((id) => snapshot.items.some((item) => item.id === id)));
    // 条目删掉后缩略图 data URL 没有留着的意义，顺手剪掉（base64 一张几十 KB）。
    setThumbs((current) => {
      const alive = new Set(snapshot.items.map((item) => item.id));
      const next: Record<string, string> = {};
      let changed = false;
      for (const [id, url] of Object.entries(current)) {
        if (alive.has(id)) next[id] = url;
        else changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  const applyResults = useCallback(async (results: AddResult[]) => {
    const rejected = results.find((result) => result.status === "rejected" && result.message);
    const added = results.some((result) => result.status === "added" || result.status === "topped");
    if (rejected?.message) setMessage(rejected.message);
    else if (added) setMessage(null);
    // 先把收起状态写上再刷新。两条异步叠在一起时，刷新会把刚展开的窗口又收起来。
    if ((added || rejected) && collapsedRef.current) {
      setCollapsed(false);
      await invoke("shelf_set_collapsed", { collapsed: false });
    }
  }, []);

  useEffect(() => {
    document.body.classList.add("file-shelf-window");
    const unlistenReady = listen("file-shelf-ready-request", () => {
      void emit("file-shelf-ready");
    });
    void emit("file-shelf-ready");
    const unlistenChanged = listen<AddResult[]>("file-shelf-changed", (event) => {
      const results = Array.isArray(event.payload) ? event.payload : [];
      runExclusive(async () => {
        await applyResults(results);
        await refresh();
      });
    });
    const unlistenArmed = listen<boolean>("file-shelf-drag-armed", (event) => {
      setDragArmed(event.payload === true);
    });
    const unlistenDragOver = listen<boolean>("file-shelf-drag-hover", (event) => {
      setDragOver(event.payload === true);
    });
    runExclusive(async () => {
      await refresh();
    });
    const stopPosition = persistWindowPositionOnMove("file-shelf-overlay");
    return () => {
      document.body.classList.remove("file-shelf-window");
      stopPosition();
      unlistenReady.then((fn) => fn());
      unlistenChanged.then((fn) => fn());
      unlistenArmed.then((fn) => fn());
      unlistenDragOver.then((fn) => fn());
    };
  }, [applyResults, refresh, runExclusive]);

  useLayoutEffect(() => {
    const extraLines = (notice ? 1 : 0) + (message ? 1 : 0);
    const size = panelWindowSize(PANEL_WIDTH, panelHeight(collapsed, items.length, extraLines));
    void win.setSize(new LogicalSize(size.width, size.height));
    clampWindowToWorkArea(size.width, size.height);
  }, [collapsed, items.length, message, notice, win]);

  // 逐个串行拉取图片/视频缩略图（后端有缓存，重复请求不重复解码）。
  // items 或 thumbs 变化都会重跑，直到每条媒体条目都有了结果或失败标记。
  useEffect(() => {
    if (collapsed) return;
    const targets = items.filter(
      (item) => !item.missing && !thumbs[item.id] && fileVisual(item).media !== null,
    );
    if (targets.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const item of targets) {
        if (cancelled) return;
        try {
          const data = await invoke<string | null>("shelf_thumbnail", { id: item.id });
          if (cancelled || !data) continue;
          setThumbs((prev) => ({ ...prev, [item.id]: data }));
        } catch {
          // 提取失败保持类型渐变兜底
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collapsed, items, thumbs]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 确认弹窗打开期间不接受粘贴（弹窗自己也在捕获阶段拦掉了相关按键）
      if (confirmClearOpenRef.current) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        runExclusive(async () => {
          try {
            const results = await invoke<AddResult[]>("shelf_paste");
            await applyResults(results);
            await refresh();
          } catch (error: unknown) {
            setMessage(typeof error === "string" ? error : "剪贴板里没有文件或图片");
          }
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyResults, refresh, runExclusive]);

  const beginDrag = (id: string) => {
    const ids = selected.includes(id) ? selected : [id];
    void invoke("shelf_begin_drag", { ids }).catch((error: unknown) => {
      setMessage(typeof error === "string" ? error : "拖出失败");
    });
  };

  const openItem = (id: string) => {
    void invoke("shelf_open", { id }).catch((error: unknown) => {
      setMessage(typeof error === "string" ? error : "打不开这个文件");
    });
  };

  // 点面板空白处取消选择；卡片、按钮和输入控件由各自的处理逻辑负责。
  const onShelfClick = (event: ReactMouseEvent) => {
    // 排序结束后补发的 click 可能落在面板根节点上（pointer capture 会改写事件目标），
    // 不能把它当成「点了空白处」。
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (
      (event.target as HTMLElement).closest(".file-card, .file-shelf-header, button, input, label")
    )
      return;
    selectionAnchor.current = null;
    setSelected((current) => (current.length === 0 ? current : []));
  };

  const onRowPointerDown = (id: string, event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    suppressClick.current = false;
    const card = event.currentTarget as HTMLElement;
    // 捕获必须挂在不会随排序移动的节点上：卡片重排时会被 insertBefore 挪位，
    // 绑在卡片上的 pointer capture 可能因此丢失，光标移出窗口后就收不到事件了。
    const captureTarget = shelfRef.current ?? card;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let mode: "pending" | "reorder" | "out" = "pending";
    let captured = false;

    const stop = () => {
      reorderPointer.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      if (captured) {
        try {
          captureTarget.releasePointerCapture(pointerId);
        } catch {
          // 指针已经结束捕获时忽略
        }
        captured = false;
      }
    };

    const cancelReorder = (restore: boolean) => {
      if (restore && orderBeforeReorder.current) {
        itemsRef.current = orderBeforeReorder.current;
        setItems(orderBeforeReorder.current);
      }
      orderBeforeReorder.current = null;
      reorderingRef.current = null;
      setReordering(null);
    };

    const commitReorder = () => {
      const before = orderBeforeReorder.current;
      orderBeforeReorder.current = null;
      reorderingRef.current = null;
      setReordering(null);
      if (!before) return;
      const current = itemsRef.current;
      const unchanged =
        current.length === before.length &&
        current.every((item, index) => item.id === before[index]?.id);
      if (unchanged) return;
      const ids = current.map((item) => item.id);
      runExclusive(async () => {
        try {
          await invoke("shelf_reorder", { ids });
        } catch (error: unknown) {
          setMessage(typeof error === "string" ? error : "调整顺序失败");
          await refresh();
        }
      });
    };

    const inPanel = (x: number, y: number, margin = 0) => {
      const panel = shelfRef.current?.getBoundingClientRect();
      if (!panel) return false;
      return (
        x >= panel.left - margin &&
        x <= panel.right + margin &&
        y >= panel.top - margin &&
        y <= panel.bottom + margin
      );
    };

    const onMove = (move: PointerEvent) => {
      if (mode === "out") return;
      if (mode === "pending") {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < 6) return;
        // 架内拖动 = 排序；一开始就拖出面板 = 拖出（沿用原来的行为）。
        if (itemsRef.current.length < 2 || !inPanel(move.clientX, move.clientY)) {
          mode = "out";
          // 拖出不是点击：别让松手后补发的 click 落到面板空白处清掉选择。
          suppressClick.current = true;
          stop();
          beginDrag(id);
          return;
        }
        mode = "reorder";
        suppressClick.current = true;
        orderBeforeReorder.current = itemsRef.current;
        reorderingRef.current = id;
        setReordering(id);
        // 捕获指针，光标移出窗口后还能收到 move，才能及时切成拖出。
        try {
          captureTarget.setPointerCapture(pointerId);
          captured = true;
        } catch {
          // 个别指针环境不支持捕获时，退化成只在窗口内排序
        }
      }
      if (mode !== "reorder") return;
      // 留 14px 余量：手抖擦过面板边缘不应该立刻变成拖出。
      if (!inPanel(move.clientX, move.clientY, 14)) {
        mode = "out";
        cancelReorder(true);
        stop();
        beginDrag(id);
        return;
      }
      reorderPointer.current = { x: move.clientX, y: move.clientY };
      const index = slotIndexAt(move.clientX, move.clientY);
      if (index < 0) return;
      const next = moveItemToIndex(itemsRef.current, id, index);
      if (next) applyOrder(next);
    };

    const onUp = () => {
      stop();
      if (mode === "reorder") commitReorder();
      mode = "out";
    };

    // pointercancel 不是「放下」：系统打断这次指针序列时不能把中途顺序当结果写回去。
    const onCancel = () => {
      stop();
      if (mode === "reorder") cancelReorder(true);
      mode = "out";
    };

    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      stop();
      if (mode === "reorder") cancelReorder(true);
      mode = "out";
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  };

  const toggleCollapsed = () => {
    const next = !collapsedRef.current;
    setCollapsed(next);
    runExclusive(async () => {
      try {
        await invoke("shelf_set_collapsed", { collapsed: next });
      } catch {
        await refresh();
      }
    });
  };

  const remove = (id: string) => {
    runExclusive(async () => {
      try {
        await invoke("shelf_remove", { ids: [id] });
      } catch (error: unknown) {
        setMessage(typeof error === "string" ? error : "删除失败");
      }
      await refresh();
    });
  };

  const clear = () => {
    setConfirmClearOpen(false);
    runExclusive(async () => {
      try {
        await invoke("shelf_clear");
      } catch (error: unknown) {
        setMessage(typeof error === "string" ? error : "清空失败");
      }
      await refresh();
    });
  };

  const onHeaderMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, label, input")) return;
    void win.startDragging();
  };

  const ownedCount = items.filter((item) => item.kind === "owned").length;
  // 待放入（拖着文件，还没到窗口上）和悬停（已经在窗口上）是两级反馈：
  // armed = 呼吸环境光 + 边缘流光引导；hover = 流光加速 + 芯片弹性落位转品牌色。
  const dropTarget = dragOver || dragArmed;
  return (
    <div
      ref={shelfRef}
      className={`file-shelf${collapsed ? " file-shelf--collapsed" : ""}${
        dropTarget ? " file-shelf--drop-target" : ""
      }${dragOver ? " file-shelf--drop-hover" : ""}${reordering ? " file-shelf--reordering" : ""}`}
      onClick={onShelfClick}
      onPointerDown={() => {
        // 新手势开始时清掉上一次拖拽留下的抑制标记；同一次拖拽补发的 click 不会经过这里。
        suppressClick.current = false;
      }}
    >
      <header className="file-shelf-header" onMouseDown={onHeaderMouseDown}>
        <Icon name="GripVertical" size={14} />
        <span className="file-shelf-title">暂存架</span>
        <span className="file-shelf-count">{items.length}</span>
        <button
          type="button"
          className="file-shelf-icon"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "展开" : "收起"}
        >
          <Icon name={collapsed ? "Maximize2" : "Minimize2"} size={14} />
        </button>
        <button
          type="button"
          className="file-shelf-icon"
          onClick={() => void win.hide()}
          aria-label="关闭"
        >
          <Icon name="X" size={14} />
        </button>
      </header>
      {!collapsed && (
        <>
          {notice && <p className="file-shelf-notice">{notice}</p>}
          {items.length === 0 ? (
            <div className="file-shelf-empty">
              <span className="file-shelf-empty-plus">
                <Icon name="Plus" size={16} />
              </span>
              把文件拖到这里
            </div>
          ) : (
            <ul className="file-shelf-grid" ref={gridRef}>
              {items.map((item) => {
                const dead = item.missing;
                const visual = fileVisual(item);
                const thumb = dead ? undefined : thumbs[item.id];
                const isRef = item.kind === "reference";
                const tooltip = itemTooltip(item);
                return (
                  <li
                    key={item.id}
                    data-shelf-id={item.id}
                    className={`file-card${dead ? " is-dead" : ""}${
                      selected.includes(item.id) ? " is-selected" : ""
                    }${reordering === item.id ? " is-dragging" : ""}`}
                    onPointerDown={(event) => onRowPointerDown(item.id, event)}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("button")) return;
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      if (event.shiftKey) {
                        const anchorIndex = selectionAnchor.current
                          ? items.findIndex((candidate) => candidate.id === selectionAnchor.current)
                          : -1;
                        const index = items.findIndex((candidate) => candidate.id === item.id);
                        if (anchorIndex >= 0 && index >= 0) {
                          const [start, end] =
                            anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
                          const range = items
                            .slice(start, end + 1)
                            .map((candidate) => candidate.id);
                          setSelected((current) =>
                            event.ctrlKey || event.metaKey
                              ? Array.from(new Set([...current, ...range]))
                              : range,
                          );
                          return;
                        }
                      }
                      if (event.ctrlKey || event.metaKey) {
                        setSelected((current) =>
                          current.includes(item.id)
                            ? current.filter((id) => id !== item.id)
                            : [...current, item.id],
                        );
                        selectionAnchor.current = item.id;
                        return;
                      }
                      setSelected([item.id]);
                      selectionAnchor.current = item.id;
                    }}
                    onDoubleClick={(event) => {
                      if ((event.target as HTMLElement).closest("button")) return;
                      if (dead || suppressClick.current) return;
                      openItem(item.id);
                    }}
                  >
                    <div className={`file-card-prev ${dead ? "dead" : visual.type}`}>
                      {thumb ? (
                        <img className="file-card-thumb" src={thumb} alt="" draggable={false} />
                      ) : (
                        <span className="file-card-glyph">
                          <FileGlyph type={dead ? "dead" : visual.type} />
                        </span>
                      )}
                      {/* 视频角标压在缩略图/渐变之上（z-index:1），标明这是视频 */}
                      {visual.media === "video" && (
                        <span className="file-card-play">
                          <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5.5v13l11-6.5z" />
                          </svg>
                        </span>
                      )}
                    </div>
                    {dead && <Icon className="file-card-warn" name="AlertCircle" size={15} />}
                    <div className="file-card-meta">
                      <div
                        className="file-card-name"
                        title={dead ? `${tooltip}\n文件已不在原位置` : `${tooltip}\n双击打开`}
                      >
                        {item.name}
                      </div>
                      <div className={`file-card-kind${!dead && isRef ? " is-ref" : ""}`}>
                        {dead ? (
                          <span className="file-card-warn-t">找不到了</span>
                        ) : isRef ? (
                          "引用"
                        ) : (
                          "副本"
                        )}
                      </div>
                    </div>
                    {!dead && (
                      <button
                        type="button"
                        className="file-card-tact"
                        aria-label="在资源管理器中显示"
                        onClick={() =>
                          void invoke("shelf_reveal", { id: item.id }).catch((error: unknown) =>
                            setMessage(typeof error === "string" ? error : "找不到了"),
                          )
                        }
                      >
                        <Icon name="FolderOpen" size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="file-card-tact is-del"
                      aria-label="从暂存架移除"
                      onClick={() => remove(item.id)}
                    >
                      <Icon name="Trash2" size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <footer className="file-shelf-footer">
            <span className="file-shelf-stat">副本 {ownedCount}</span>
            <span className="file-shelf-stat is-ref">引用 {items.length - ownedCount}</span>
            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              disabled={items.length === 0}
            >
              清空
            </button>
          </footer>
          {message && <p className="file-shelf-message">{message}</p>}
        </>
      )}
      {dropTarget && (
        <div className="file-shelf-drop" aria-hidden="true">
          {/* 光尘：缓缓上升的光点，收起态（36px）没有空间，由 CSS 隐藏 */}
          <span className="speck s1" />
          <span className="speck s2" />
          <span className="speck s3" />
          <span className="speck s4" />
          {/* 收起时只有 36px 高，芯片会压到标题上，只留环境光和流光。 */}
          {!collapsed && (
            <span className="file-shelf-drop-chip">
              <Icon name="Download" size={16} />
              {dragOver ? "松手放入暂存架" : "把文件拖到这里"}
            </span>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmClearOpen}
        danger
        title="清空暂存架？"
        description={
          items.length === 0 ? (
            "清单将全部移除"
          ) : (
            <>
              {items.length} 个条目会全部移除，其中 <b>{ownedCount} 个副本</b>
              将从暂存目录删除；引用的原文件留在原地。
            </>
          )
        }
        confirmLabel="清空"
        onConfirm={clear}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </div>
  );
}

export default FileShelf;
