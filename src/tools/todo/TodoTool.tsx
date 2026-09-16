import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FocusEvent as ReactFocusEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import { applyThemePreferences, getStoredThemePreferences, subscribeThemePreferences } from "../../styles/themePreferences";
import { clampWindowToWorkArea } from "../../utils/panelWindow";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import { ensureTimerWindow } from "../../utils/toolWindows";
import "./TodoTool.css";

type TodoStatus = "active" | "completed";
type TodoPriority = "low" | "normal" | "high" | "urgent";
type TodoRepeatRule = "none" | "daily" | "weekly" | "workdays";
interface TodoItem {
  id: string;
  title: string;
  notes?: string;
  priority?: TodoPriority;
  tags?: string[];
  listId?: string;
  repeatRule?: TodoRepeatRule;
  status: TodoStatus;
  dueAt?: string;
  remindAt?: string;
  completedAt?: string;
  deletedAt?: string;
}
interface TodoList { id: string; name: string; createdAt: string; updatedAt: string; }
interface TodoFocusPayload { todoId?: string; itemId?: string; }
/**
 * 清单筛选里的伪选项：选中它时不做清单过滤，显示全部任务。
 *
 * 复用空串是因为它与「任务不属于任何清单」（`listId` 为空）取值一致 —— 两者都是
 * 「这一项没有清单归属」，没必要再造一个魔法值。清单全部由用户自建，可以一个都没有。
 */
const ALL_LISTS_ID = "";
/** 窗口宽度固定（与 toolWindows.ts 的建窗尺寸一致），高度随面板实测内容走。 */
const TODO_WINDOW_WIDTH = 360;
/**
 * 指针移开后收起顶部控件的延迟。
 *
 * 不能立即收起：`<select>` / `<input type="datetime-local">` 在 Windows 上弹出的是
 * **独立原生窗口**，指针移到弹窗上时 WebView 会收到 mouseleave —— 立刻收起会把正在
 * 交互的弹窗连同输入框一起拆掉。延迟是给这段位移留的缓冲，真正的兜底是
 * autoCollapseBlockedRef（面板正被使用时直接放弃本次收起）。
 */
const COLLAPSE_DELAY_MS = 500;
const normalizeTagForComparison = (tag: string) => tag.trim().toLocaleLowerCase();

const toLocalInput = (iso?: string) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);

const localDateTime = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const dateAt = (daysFromToday: number, hour: number, minute = 0) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  date.setDate(date.getDate() + daysFromToday);
  return localDateTime(date);
};

const nextMondayAt = (hour: number) => {
  const date = new Date();
  const daysUntilMonday = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + daysUntilMonday);
  date.setHours(hour, 0, 0, 0);
  return localDateTime(date);
};

const minutesFromNow = (minutes: number) => localDateTime(new Date(Date.now() + minutes * 60_000));

const hasItemDetails = (item: TodoItem) => Boolean(
  item.notes
  || item.remindAt
  || (item.tags?.length ?? 0) > 0
  || (item.repeatRule && item.repeatRule !== "none")
  || (item.priority && item.priority !== "normal"),
);

/**
 * 面板内是否有可输入元素获得焦点（折叠要为此让路，见 scheduleCollapse）。
 *
 * 必须包含 `<select>`：Windows 上它的下拉是独立原生窗口，选到一半把面板收起来会把
 * 下拉一起拆掉。不能连按钮一起算进来 —— 勾选/删除点完焦点会留在按钮上，那样窗口
 * 就「点过一次再也不收起」了。
 *
 * 这些元素把窗口「粘」在展开态只是暂时的：焦点一离开面板，handlePanelBlur 会补上
 * 收起判定。
 */
const isInputFocusedInPanel = (panel: HTMLElement | null) => {
  const active = document.activeElement;
  if (!panel || !(active instanceof HTMLElement) || active === document.body) return false;
  if (!panel.contains(active)) return false;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable;
};

function TodoTool() {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [deletedItems, setDeletedItems] = useState<TodoItem[]>([]);
  const [lists, setLists] = useState<TodoList[]>([]);
  const [selectedListId, setSelectedListId] = useState<string>(ALL_LISTS_ID);
  const [newListName, setNewListName] = useState("");
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editListName, setEditListName] = useState("");
  const [confirmDeleteListId, setConfirmDeleteListId] = useState<string | null>(null);
  // 「清空回收站」是**永久删除**（不经过回收站、没有撤销），必须二次确认 ——
  // 单条删除有 5s 撤销、删除清单也有二次确认，这里是唯一的例外。
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<"all" | "today" | "completed" | "trash">("all");
  // 离开回收站就退出「确认清空」态：否则切走再切回来会直接停在「确认清空（不可恢复）」
  // 按钮上（状态残留）。不逐个按钮里重置，是为了覆盖所有离开路径（回收站开关、
  // 返回待办、点待办/今天/已完成页签、切换清单）。
  // ⚠️ 必须放在 `filter` 声明**之后**：`const` 不提升，写前面会 TDZ 报错。
  useEffect(() => {
    if (filter !== "trash") setConfirmPurge(false);
  }, [filter]);
  const [selectedTag, setSelectedTag] = useState("");
  const [sortMode, setSortMode] = useState<"priority" | "manual">("manual");
  const [dueAt, setDueAt] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [priority, setPriority] = useState<TodoPriority>("normal");
  const [repeatRule, setRepeatRule] = useState<TodoRepeatRule>("none");
  const [tags, setTags] = useState("");
  const [query, setQuery] = useState("");
  const [showAddOptions, setShowAddOptions] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showListManager, setShowListManager] = useState(false);
  // 折叠态：只留标题栏 + 任务列表，用于长期挂在桌面。指针移开自动进入，移入立即退出。
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedIdState] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editPriority, setEditPriority] = useState<TodoPriority>("normal");
  const [editRepeatRule, setEditRepeatRule] = useState<TodoRepeatRule>("none");
  const [editTags, setEditTags] = useState("");
  const [editListId, setEditListId] = useState<string>(ALL_LISTS_ID);
  const [editDueAt, setEditDueAt] = useState("");
  const [editRemindAt, setEditRemindAt] = useState("");
  const [undoItem, setUndoItem] = useState<TodoItem | null>(null);
  const [lastReminder, setLastReminder] = useState<TodoItem | null>(null);
  const [showSnoozePicker, setShowSnoozePicker] = useState(false);
  const [snoozeAt, setSnoozeAt] = useState("");
  const [activeFocusTodoId, setActiveFocusTodoId] = useState<string | null>(null);
  const [focusedTodoId, setFocusedTodoId] = useState<string | null>(null);
  const [ioMessage, setIoMessage] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverBefore, setDragOverBefore] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  // 已下发的窗口尺寸（"宽:高"）。ResizeObserver 首次回调、折叠切换重跑都必须被去重吃掉，
  // 否则同一尺寸会被反复 setSize，窗口持续重排。
  const lastWindowSizeRef = useRef("");
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 指针是否停在面板上。收起判定在 setSize/折叠之外还要用它：焦点离开面板时可能
  // 早已没有新的 mouseleave 可依赖（见 handlePanelBlur）。
  const pointerInsideRef = useRef(false);
  // 有正在交互的面板时不自动收起（渲染体内同步更新，见下方赋值处）
  const autoCollapseBlockedRef = useRef(false);
  const itemsRef = useRef<TodoItem[]>([]);
  itemsRef.current = items;
  // 打开着「更多任务选项 / 搜索」或正在编辑任务时，指针可能正停在原生弹层（日期选择器、
  // 下拉菜单）上 —— 那不算「用户离开了」，此时自动收起会把弹窗连同输入框一起拆掉。
  autoCollapseBlockedRef.current = showAddOptions || showSearch || editingId !== null;
  // 拖拽期间标记：用于抑制 refresh 覆盖本地实时重排、判断是否产生净位移
  const dragIdRef = useRef<string | null>(null);
  const dragStartIndexRef = useRef(-1);
  const setExpandedId = useCallback((value: string | null) => {
    const target = value ? itemsRef.current.find((item) => item.id === value) : undefined;
    if (target && !hasItemDetails(target)) return;
    setExpandedIdState(value);
  }, []);
  const win = useMemo(() => getCurrentWebviewWindow(), []);

  /** 指针移入：立即展开，并取消排队中的收起。 */
  const expandPanel = useCallback(() => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    setCollapsed(false);
  }, []);

  /** 指针移出：延迟收起（留出去原生弹层的位移时间），面板正被使用时放弃本次收起。 */
  const scheduleCollapse = useCallback(() => {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      if (autoCollapseBlockedRef.current) return;
      // 窗口若已被隐藏（点关闭 / 托盘收起 / 截图会话临时隐藏），**不要**进入折叠态：
      // 隐藏同样会让 WebView 收到 mouseleave，照常收起的话，下次点「待办」看到的就是
      // 一个只剩任务列表的小条 —— 用户点它是想用完整面板的。保持隐藏前的样子。
      // 依据：`Window::set_visible` 会走到 WebView2 `SetIsVisible`，隐藏时页面确实被置为
      // hidden（与 ScrollNavigator 靠 document.hidden 停轮询同源，见 docs/滚动导航问题分析.md）。
      if (document.hidden) return;
      // 有可输入元素还带着焦点时不收起：折叠会把输入框/下拉一起 display: none ——
      // 用户输入到一半去别处复制文字（指针离开窗口），回来时输入框和光标位置全没了。
      // 焦点一旦离开面板，handlePanelBlur 会补上这次收起判定，不会一直粘着。
      if (isInputFocusedInPanel(panelRef.current)) return;
      // 拖拽排序进行中不收起：折叠会把列表上方的控件一起撤掉，正在拖的目标行
      // 跟着整体上移，落点直接跳掉（拖拽时指针本来就常常在窗口外）。
      if (dragIdRef.current) return;
      setCollapsed(true);
    }, COLLAPSE_DELAY_MS);
  }, []);

  /** 指针进入/离开面板：expandPanel/scheduleCollapse 之外还要记下指针位置，见 handlePanelBlur。 */
  const handlePointerEnter = useCallback(() => {
    pointerInsideRef.current = true;
    expandPanel();
  }, [expandPanel]);

  const handlePointerLeave = useCallback(() => {
    pointerInsideRef.current = false;
    scheduleCollapse();
  }, [scheduleCollapse]);

  /**
   * 焦点离开面板时补一次收起判定。
   *
   * 有输入焦点时指针移开是被放行的（见 scheduleCollapse），但那一刻不会再有新的
   * mouseleave —— 用户输入完直接去点别的窗口（指针早已在面板外），没有这一步窗口
   * 就会一直停在展开态。指针还在面板上则不必补：用户只是在面板内换了个焦点。
   */
  const handlePanelBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && panelRef.current?.contains(next)) return;
    if (pointerInsideRef.current) return;
    scheduleCollapse();
  }, [scheduleCollapse]);

  const refresh = useCallback(() => {
    void invoke<TodoItem[]>("get_todos", { includeCompleted: true, sortMode }).then((value) => {
      // 拖拽期间保留本地实时重排，避免服务端顺序覆盖导致 beforeId 错位
      if (dragIdRef.current) return;
      setItems(Array.isArray(value) ? value : []);
    }).catch(console.error);
    void invoke<TodoItem[]>("get_deleted_todos").then((value) => setDeletedItems(Array.isArray(value) ? value : [])).catch(console.error);
    void invoke<TodoList[]>("get_todo_lists").then((value) => {
      const next = Array.isArray(value) ? value : [];
      setLists(next);
      // 选中的清单被删掉（或本来就没选）时回到「全部任务」，不要停在已失效的 id 上。
      setSelectedListId((current) => (current && next.some((list) => list.id === current)) ? current : ALL_LISTS_ID);
    }).catch(console.error);
  }, [sortMode]);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    // 刻意不设 root 高度：窗口高度由下面按面板实测值下发，撑满窗口会让「量高度」量到
    // 窗口自身，形成越测越大的反馈环（见 developer-guide 第 10 条）。
    if (root) { root.style.background = "transparent"; root.style.margin = "0"; }
  }, []);

  useEffect(() => {
    const themeUnlisten = subscribeThemePreferences();
    void emit("todo-window-ready");
    const readyRequest = listen("todo-window-ready-request", () => void emit("todo-window-ready"));
    const changed = listen("todo-changed", refresh);
    const reminder = listen<{ item: TodoItem }>("todo-reminder", (event) => {
      setLastReminder(event.payload.item);
      refresh();
    });
    // The tool-level switch silences reminders globally. Clear any toast that
    // was already mounted so re-enabling the window cannot resurrect it.
    const remindersSilenced = listen("todo-reminders-silenced", () => {
      setLastReminder(null);
      setShowSnoozePicker(false);
      setSnoozeAt("");
    });
    const focusAdd = listen("todo-focus-add", () => {
      // 折叠态下输入框是 display: none，focus() 会静默失败 —— 快速添加必须先展开窗口
      expandPanel();
      window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    });
    const focusItem = listen<TodoFocusPayload>("todo-focus-item", (event) => {
      const id = event.payload.todoId ?? event.payload.itemId;
      if (!id) return;
      expandPanel();
      const target = itemsRef.current.find((item) => item.id === id);
      if (target) {
        setSelectedListId(target.listId ?? ALL_LISTS_ID);
        setFilter(target.status === "completed" ? "completed" : "all");
      }
      setQuery("");
      setExpandedId(id);
      setFocusedTodoId(id);
      setLastReminder(null);
      refresh();
    });
    const pomodoroTick = listen<{ active_todo_id?: string | null }>("pomodoro-tick", (event) => {
      setActiveFocusTodoId(event.payload?.active_todo_id ?? null);
    });
    void invoke<{ active_todo_id?: string | null }>("get_pomodoro_state")
      .then((state) => setActiveFocusTodoId(state?.active_todo_id ?? null))
      .catch(console.error);
    refresh();
    return () => {
      themeUnlisten.then((fn) => fn()).catch(console.error);
      readyRequest.then((fn) => fn()).catch(console.error);
      changed.then((fn) => fn()).catch(console.error);
      reminder.then((fn) => fn()).catch(console.error);
      remindersSilenced.then((fn) => fn()).catch(console.error);
      focusAdd.then((fn) => fn()).catch(console.error);
      focusItem.then((fn) => fn()).catch(console.error);
      pomodoroTick.then((fn) => fn()).catch(console.error);
    };
  }, [refresh, expandPanel]);

  useEffect(() => persistWindowPositionOnMove("todo-overlay"), []);

  /**
   * 窗口高度随内容走。
   *
   * 窗口是定宽 360 的无边框浮窗，高度必须等于此刻面板的实测高度：任务少时窗口就该只有
   * 标题栏 + 几条任务，任务多时由 `.todo-list` 的 max-height 收口 —— 固定 560 的旧写法
   * 在空清单时下面空一大片。折叠/展开、面板开合、提醒 toast 出现都会改高度，所以用
   * ResizeObserver 跟随，而不是只跟着 items.length 跑一次。
   *
   * 量的是 `.todo-body` 的自然高度：CSS 里它**不能**是 height: 100%（那样量到的就是窗口
   * 高度，窗口只会越调越大）。用 `offsetHeight` 而不是 `getBoundingClientRect()`——后者会
   * 把 `.todo-container` 入场动画的 scale(.985) 算进去，首帧高度偏小约 1.5%。
   */
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const resizeToContent = () => {
      const height = panel.offsetHeight;
      // 0 = 还没布局（测试环境不做布局），此时下发会把窗口压成一条
      if (height <= 0) return;
      const key = `${TODO_WINDOW_WIDTH}:${height}`;
      if (key === lastWindowSizeRef.current) return;
      lastWindowSizeRef.current = key;
      win
        .setSize(new LogicalSize(TODO_WINDOW_WIDTH, height))
        .catch((error) => console.error("调整待办窗口尺寸失败:", error));
      // 任务变多/展开面板都会改窗口高度，贴屏幕下沿时要重新夹回工作区
      clampWindowToWorkArea(TODO_WINDOW_WIDTH, height);
    };

    resizeToContent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [win]);

  // 新提醒到来或 toast 被关闭/聚焦消失时复位自定义延后面板，避免上一轮状态残留。
  useEffect(() => {
    setShowSnoozePicker(false);
    setSnoozeAt("");
  }, [lastReminder]);

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
  }, []);

  const addTodo = async () => {
    const value = title.trim();
    // 同 saveEditing：空标题给可见反馈，不要静默 return
    if (!value) {
      setIoMessage("请输入任务标题");
      inputRef.current?.focus();
      return;
    }
    try {
      const input: Record<string, unknown> = { title: value, priority, tags: tags.split(","), dueAt: toIso(dueAt), remindAt: toIso(remindAt) };
      if (repeatRule !== "none") input.repeatRule = repeatRule;
      if (selectedListId) input.listId = selectedListId;
      await invoke("create_todo", { input });
      setTitle(""); setTags(""); setPriority("normal"); setRepeatRule("none"); setDueAt(""); setRemindAt(""); setShowAddOptions(false); inputRef.current?.focus();
    } catch (error) { console.error("create todo failed", error); setIoMessage("添加任务失败"); }
  };

  const createList = async () => {
    const name = newListName.trim();
    if (!name) return;
    try {
      const list = await invoke<TodoList>("create_todo_list", { input: { name } });
      setNewListName("");
      if (list?.id) setSelectedListId(list.id);
    } catch (error) { console.error("create todo list failed", error); setIoMessage("创建清单失败"); }
  };

  const saveListName = async (id: string) => {
    const name = editListName.trim();
    if (!name) return;
    try { await invoke("update_todo_list", { id, input: { name } }); setEditingListId(null); }
    catch (error) { console.error("update todo list failed", error); setIoMessage("重命名清单失败"); }
  };

  const deleteList = async (id: string) => {
    try { await invoke("delete_todo_list", { id }); setConfirmDeleteListId(null); setSelectedListId(ALL_LISTS_ID); }
    catch (error) { console.error("delete todo list failed", error); setIoMessage("删除清单失败"); }
  };

  const purgeDeleted = async () => {
    try { await invoke("purge_deleted_todos"); }
    catch (error) { console.error("purge deleted todos failed", error); setIoMessage("清空回收站失败"); }
  };

  const exportTodos = async () => {
    try { if (await invoke<boolean>("export_todos")) setIoMessage("导出成功"); }
    catch (error) { console.error("export todos failed", error); setIoMessage("导出失败"); }
  };

  const importTodos = async () => {
    try { if (await invoke<boolean>("import_todos")) { setIoMessage("导入成功"); } }
    catch (error) { console.error("import todos failed", error); setIoMessage("导入失败"); }
  };

  // 拖拽排序依赖 items 的 sort_order 顺序（beforeId 取同组下一项），
  // 仅手动排序模式下 items 按 sort_order 排列，故优先级排序下禁用拖拽。
  const canDrag = filter !== "trash" && filter !== "today" && sortMode === "manual";

  const getInsertion = (list: TodoItem[], fromId: string, targetId: string, clientY: number) => {
    const from = list.findIndex((item) => item.id === fromId);
    const to = list.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0 || from === to) return null;
    const targetEl = itemRefs.current[targetId];
    const rowEl = targetEl?.querySelector<HTMLElement>(".todo-item-row");
    if (!rowEl) return null;
    const rect = rowEl.getBoundingClientRect();
    // 用光标相对目标行的上下半区决定插前/插后；测试或无指针环境下退化为按拖拽方向判断。
    const hasPointer = rect.height > 0 && Number.isFinite(clientY);
    const before = hasPointer ? clientY < rect.top + rect.height / 2 : from > to;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    const targetPos = next.findIndex((item) => item.id === targetId);
    const insertAt = before ? targetPos : targetPos + 1;
    if (insertAt === from) return null;
    next.splice(insertAt, 0, moved);
    return { before, next };
  };

  const handleDragStart = (event: DragEvent, itemId: string) => {
    if (!canDrag) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
    dragIdRef.current = itemId;
    dragStartIndexRef.current = items.findIndex((item) => item.id === itemId);
    setDragId(itemId);
  };

  /**
   * 两行是否属于同一个拖拽分组（清单 + 状态）。
   *
   * 后端 `move_to` 只按「清单 + 状态」分组重排，前端的落点判定必须用同一分组：
   * 「全部任务」视图里不同清单的行是混排的，若允许把行拖到别的清单的行上，本地重排
   * 的结果与落库结果对不上 —— 松手后该行会跳回自己分组里的位置。
   */
  const isSameDragGroup = (a?: TodoItem, b?: TodoItem) => {
    if (!a || !b) return false;
    return (a.listId ?? ALL_LISTS_ID) === (b.listId ?? ALL_LISTS_ID) && a.status === b.status;
  };

  const handleDragOver = (event: DragEvent, targetId: string) => {
    if (!canDrag || !dragId || dragId === targetId) return;
    // 不 preventDefault：跨分组落点直接显示为「不可放置」，比拖完再跳回去直观。
    if (!isSameDragGroup(items.find((candidate) => candidate.id === dragId), items.find((candidate) => candidate.id === targetId))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverId(targetId);
    const result = getInsertion(items, dragId, targetId, event.clientY);
    if (!result) return;
    setDragOverBefore(result.before);
    setItems(result.next);
  };

  const handleDragEnd = async () => {
    const draggedId = dragId;
    setDragId(null);
    setDragOverId(null);
    dragIdRef.current = null;
    if (!draggedId) return;
    const finalIndex = items.findIndex((item) => item.id === draggedId);
    const target = items.find((item) => item.id === draggedId);
    // 无净位移（含拖回原位/未移动）不提交，避免整组 sort_order 被无意义重编号
    if (!target || finalIndex === dragStartIndexRef.current) { refresh(); return; }
    const targetListId = target.listId ?? ALL_LISTS_ID;
    const targetStatus = target.status;
    // 以本地重排后的 items 定位拖拽项后第一个同组任务作为插入锚点，
    // 与后端 move_to 的 peers 分组保持一致（搜索过滤时不会被过滤项隔断）。
    let beforeId: string | null = null;
    for (let i = finalIndex + 1; i < items.length; i++) {
      const candidate = items[i];
      if ((candidate.listId ?? ALL_LISTS_ID) === targetListId && candidate.status === targetStatus) {
        beforeId = candidate.id;
        break;
      }
    }
    try {
      await invoke("move_todo", { id: draggedId, beforeId });
    } catch (error) { console.error("move todo failed", error); setIoMessage("调整顺序失败"); refresh(); }
  };

  const startFocus = async (id: string) => {
    try {
      await invoke("start_pomodoro_for_todo", { todoId: id });
      setActiveFocusTodoId(id);
      // 番茄钟已并入「时间工具」：打开时间工具窗口后广播切页事件，
      // 让它直接停在番茄钟页签，而不是上次记忆的页签。
      await ensureTimerWindow();
      await invoke("show_timer_window");
      await emit("timer-focus-pomodoro");
    } catch (error) { console.error("start todo focus failed", error); setIoMessage("启动专注失败"); }
  };

  const toggleTodo = async (item: TodoItem) => {
    try { await invoke("set_todo_completed", { id: item.id, completed: item.status !== "completed" }); }
    catch (error) { console.error("update todo failed", error); setIoMessage("更新任务失败"); }
  };

  const removeTodo = async (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    try { await invoke("delete_todo", { id }); }
    catch (error) { console.error("delete todo failed", error); setIoMessage("删除任务失败"); return; }
    if (item) {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      setUndoItem(item);
      undoTimerRef.current = setTimeout(() => {
        setUndoItem(null);
        undoTimerRef.current = null;
      }, 5000);
    }
  };

  const undoDelete = async (itemToRestore?: TodoItem) => {
    if (!undoItem && !itemToRestore) return;
    const item = itemToRestore ?? undoItem;
    if (!item) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoItem(null);
    undoTimerRef.current = null;
    try { await invoke("restore_todo", { id: item.id }); }
    catch (error) { console.error("restore todo failed", error); setIoMessage("恢复任务失败"); }
  };

  // toast 停留期间任务可能已被标记完成：snooze_todo 后端会拒绝相对延后，
  // 而绝对延后走 update_todo 不会校验状态，故两类延后统一前置已完成拦截。
  const isCompletedTodo = (id: string) => itemsRef.current.find((candidate) => candidate.id === id)?.status === "completed";

  const snoozeTodo = async (id: string, minutes: number) => {
    if (isCompletedTodo(id)) { setIoMessage("已完成任务不能延后提醒"); return; }
    try {
      await invoke("snooze_todo", { id, minutes });
      setLastReminder(null);
    } catch (error) { console.error("snooze todo failed", error); setIoMessage("延后提醒失败"); }
  };

  // 绝对时间延后：update_todo 会把 remind_at 设为任意目标时间并重置已提醒标记，
  // 因此可支持“明天/后天/任意具体时刻”，不受 snooze_todo 1440 分钟上限约束。
  const snoozeTodoAt = async (id: string, local: string) => {
    if (isCompletedTodo(id)) { setIoMessage("已完成任务不能延后提醒"); return; }
    const iso = toIso(local);
    if (!iso) { setIoMessage("请选择延后时间"); return; }
    if (new Date(iso).getTime() <= Date.now()) { setIoMessage("延后时间需晚于当前时间"); return; }
    try {
      await invoke("update_todo", { id, input: { remindAt: iso } });
      setLastReminder(null);
    } catch (error) { console.error("snooze todo failed", error); setIoMessage("延后提醒失败"); }
  };

  const openSnoozePicker = () => {
    setSnoozeAt(dateAt(1, 9));
    setShowSnoozePicker(true);
  };

  const focusTodo = useCallback((id: string) => {
    const target = items.find((item) => item.id === id) ?? (lastReminder?.id === id ? lastReminder : undefined);
    if (target) {
      setSelectedListId(target.listId ?? ALL_LISTS_ID);
      setFilter(target.status === "completed" ? "completed" : "all");
    }
    // 从桌面上的折叠态点提醒 toast 进入：先把窗口展开，否则任务详情仍是隐藏的
    expandPanel();
    setQuery("");
    setExpandedId(id);
    setFocusedTodoId(id);
    setLastReminder(null);
  }, [items, lastReminder, expandPanel]);

  const startEditing = (item: TodoItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditNotes(item.notes ?? "");
    setEditPriority(item.priority ?? "normal");
    setEditRepeatRule(item.repeatRule ?? "none");
    setEditTags((item.tags ?? []).join(", "));
    setEditListId(item.listId ?? ALL_LISTS_ID);
    setEditDueAt(toLocalInput(item.dueAt));
    setEditRemindAt(toLocalInput(item.remindAt));
    setExpandedIdState(item.id);
  };

  const saveEditing = async (id: string) => {
    const value = editTitle.trim();
    // 空标题不能静默 return：用户点了「保存」却什么都没发生，会以为已经存住了。
    if (!value) {
      setIoMessage("请输入任务标题");
      return;
    }
    try {
      await invoke("update_todo", {
        id,
        input: { title: value, notes: editNotes, priority: editPriority, repeatRule: editRepeatRule, tags: editTags.split(","), listId: editListId, dueAt: toIso(editDueAt) ?? null, remindAt: toIso(editRemindAt) ?? null },
      });
      setEditingId(null);
      setExpandedId(null);
    } catch (error) { console.error("edit todo failed", error); setIoMessage("保存任务失败"); }
  };

  const visibleItems = (filter === "trash" ? deletedItems : items).filter((item) => {
    const normalized = query.trim().toLowerCase();
    const matchesQuery = !normalized || item.title.toLowerCase().includes(normalized) || (item.notes ?? "").toLowerCase().includes(normalized) || (item.tags ?? []).some((tag) => tag.toLowerCase().includes(normalized));
    const matchesTag = !selectedTag || (item.tags ?? []).some((tag) => normalizeTagForComparison(tag) === normalizeTagForComparison(selectedTag));
    // 选中「全部任务」时不做清单过滤，未归类任务也一并显示。
    if (filter !== "trash" && selectedListId !== ALL_LISTS_ID && item.listId !== selectedListId) return false;
    if (filter === "trash") return matchesQuery && matchesTag;
    if (filter === "completed") return item.status === "completed" && matchesQuery && matchesTag;
    if (filter === "today") {
      if (!item.dueAt) return false;
      const date = new Date(item.dueAt); const now = new Date();
      return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate() && item.status === "active" && matchesQuery && matchesTag;
    }
    if (item.status !== "active") return false;
    return matchesQuery && matchesTag;
  });

  const availableTags = useMemo(() => {
    const tagsByNormalizedValue = new Map<string, string>();
    (filter === "trash" ? deletedItems : items).forEach((item) => {
      if (filter !== "trash" && selectedListId !== ALL_LISTS_ID && item.listId !== selectedListId) return;
      (item.tags ?? []).forEach((tag) => {
        const value = tag.trim();
        if (value) tagsByNormalizedValue.set(normalizeTagForComparison(value), value);
      });
    });
    return [...tagsByNormalizedValue.values()].sort((a, b) => a.localeCompare(b));
  }, [deletedItems, filter, items, selectedListId]);

  useEffect(() => {
    if (selectedTag && !availableTags.some((tag) => normalizeTagForComparison(tag) === normalizeTagForComparison(selectedTag))) {
      setSelectedTag("");
    }
  }, [availableTags, selectedTag]);

  useEffect(() => {
    if (!focusedTodoId) return;
    const scrollTimer = window.setTimeout(() => {
      itemRefs.current[focusedTodoId]?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
    const clearTimer = window.setTimeout(() => setFocusedTodoId(null), 2200);
    return () => { window.clearTimeout(scrollTimer); window.clearTimeout(clearTimer); };
  }, [focusedTodoId, filter, selectedListId, visibleItems.length]);

  useEffect(() => {
    if (!editingId) return;
    const scrollTimer = window.setTimeout(() => {
      itemRefs.current[editingId]?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(scrollTimer);
  }, [editingId]);

  const formatDue = (value?: string) => {
    if (!value) return "";
    const date = new Date(value); if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const renderDateField = (
    label: "截止" | "提醒",
    value: string,
    onChange: (next: string) => void,
  ) => {
    const shortcuts = label === "截止"
      ? [{ label: "今天 18:00", value: () => dateAt(0, 18) }, { label: "明天 09:00", value: () => dateAt(1, 9) }, { label: "下周一", value: () => nextMondayAt(9) }]
      : [{ label: "10 分钟后", value: () => minutesFromNow(10) }, { label: "1 小时后", value: () => minutesFromNow(60) }, { label: "明早 09:00", value: () => dateAt(new Date().getHours() < 9 ? 0 : 1, 9) }];
    return <div className="todo-date-field"><div className="todo-date-field-head"><span>{label}</span><div className="todo-date-shortcuts">{shortcuts.map((shortcut) => <button key={shortcut.label} type="button" onClick={() => onChange(shortcut.value())}>{shortcut.label}</button>)}{value && <button className="todo-date-clear" type="button" onClick={() => onChange("")}>清除</button>}</div></div><input aria-label={`${label}时间`} type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} /></div>;
  };

  return (
    <div
      className={`todo-container${collapsed ? " is-collapsed" : ""}`}
      onMouseEnter={handlePointerEnter}
      onMouseLeave={handlePointerLeave}
    >
      <div className="todo-body" ref={panelRef} onBlur={handlePanelBlur}>
        <div className="todo-titlebar" onMouseDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button")) { event.preventDefault(); void win.startDragging(); } }}>
          <span className="todo-title">待办清单</span>
          <span className="todo-count">{items.filter((item) => item.status === "active" && (selectedListId === ALL_LISTS_ID || item.listId === selectedListId)).length}</span>
          <button className={`todo-icon-btn${showSearch ? " is-active" : ""}`} aria-label="搜索任务" title="搜索任务" onClick={() => { setShowSearch((value) => !value); setShowMore(false); }}><Icon name="Search" size={14} /></button>
          <button className={`todo-icon-btn${showMore ? " is-active" : ""}`} aria-label="更多操作" title="更多操作" onClick={() => { setShowMore((value) => !value); setShowSearch(false); }}><Icon name="Settings" size={14} /></button>
          <button className="todo-icon-btn todo-close-btn" aria-label="关闭待办清单" title="关闭待办清单" onClick={() => void invoke("hide_todo_window")}><Icon name="X" size={14} /></button>
        </div>

        {showMore && <div className="todo-more-panel" role="menu">
          <div className="todo-more-section"><span>排序</span><div className="todo-segmented"><button className={sortMode === "priority" ? "is-active" : ""} onClick={() => { setSortMode("priority"); setShowMore(false); }}>优先级</button><button className={sortMode === "manual" ? "is-active" : ""} onClick={() => { setSortMode("manual"); setShowMore(false); }}>手动</button></div></div>
          <div className="todo-more-actions"><button onClick={() => void importTodos()}><Icon name="Download" size={13} />导入任务</button><button onClick={() => void exportTodos()}><Icon name="Save" size={13} />导出任务</button><button className={filter === "trash" ? "is-active" : ""} onClick={() => { setFilter(filter === "trash" ? "all" : "trash"); setShowMore(false); }}><Icon name="Trash2" size={13} />回收站</button></div>
        </div>}

        <div className="todo-add-row">
          <input ref={inputRef} value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addTodo(); }} placeholder="添加任务..." maxLength={500} />
          <button className={`todo-option-btn${showAddOptions ? " is-active" : ""}`} aria-label="更多任务选项" title="更多任务选项" onClick={() => setShowAddOptions((value) => !value)}><Icon name="ListFilter" size={15} /></button>
          <button className="todo-add-btn" aria-label="添加任务" title="添加任务" onClick={() => void addTodo()}><Icon name="Check" size={16} /></button>
        </div>
        {showAddOptions && <div className="todo-add-options">
          <div className="todo-date-row">{renderDateField("截止", dueAt, setDueAt)}{renderDateField("提醒", remindAt, setRemindAt)}</div>
          <div className="todo-meta-row"><select aria-label="任务优先级" value={priority} onChange={(event) => setPriority(event.target.value as TodoPriority)}><option value="normal">普通优先级</option><option value="low">低优先级</option><option value="high">高优先级</option><option value="urgent">紧急</option></select><input aria-label="任务标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用逗号分隔" /><select aria-label="任务重复" value={repeatRule} onChange={(event) => setRepeatRule(event.target.value as TodoRepeatRule)}><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="workdays">工作日</option></select></div>
        </div>}

        {filter !== "trash" && <div className="todo-list-bar"><select aria-label="Todo list" value={selectedListId} onChange={(event) => { setSelectedListId(event.target.value); setFilter("all"); }}><option value="">全部任务</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select><button className={`todo-list-manage-btn${showListManager ? " is-active" : ""}`} aria-label="管理清单" title="管理清单" onClick={() => setShowListManager((value) => !value)}><Icon name="ListOrdered" size={14} /></button></div>}
        {filter !== "trash" && showListManager && <div className="todo-list-manager">
          <div className="todo-list-create"><input aria-label="New list name" value={newListName} onChange={(event) => setNewListName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createList(); }} placeholder="新建清单" maxLength={80} /><button className="todo-list-action" aria-label="Create list" onClick={() => void createList()}><Icon name="Plus" size={14} /></button></div>
          {selectedListId !== ALL_LISTS_ID && <div className="todo-list-edit"><span>{lists.find((list) => list.id === selectedListId)?.name}</span>{editingListId === selectedListId ? <><input aria-label="Edit list name" value={editListName} onChange={(event) => setEditListName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveListName(selectedListId); }} /><button className="todo-list-action" aria-label="Save list name" title="保存清单名称" onClick={() => void saveListName(selectedListId)}><Icon name="Check" size={14} /></button></> : <button className="todo-list-action" aria-label="Rename list" title="重命名清单" onClick={() => { setEditingListId(selectedListId); setEditListName(lists.find((list) => list.id === selectedListId)?.name ?? ""); }}><Icon name="Pencil" size={14} /></button>}{confirmDeleteListId === selectedListId ? <><button className="todo-list-action" aria-label="Confirm delete list" title="确认删除清单" onClick={() => void deleteList(selectedListId)}><Icon name="Check" size={14} /></button><button className="todo-list-action" aria-label="Cancel delete list" title="取消删除" onClick={() => setConfirmDeleteListId(null)}><Icon name="X" size={14} /></button></> : <button className="todo-list-action" aria-label="Delete list" title="删除清单" onClick={() => setConfirmDeleteListId(selectedListId)}><Icon name="Trash2" size={14} /></button>}</div>}
        </div>}
        {showSearch && <div className="todo-search"><Icon name="Search" size={14} /><input autoFocus aria-label="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务标题、备注或标签" /></div>}

        {filter === "trash" ? <div className="todo-trash-state"><span><Icon name="Trash2" size={13} />回收站</span><button onClick={() => setFilter("all")}>返回待办</button></div> : <div className="todo-filters" role="tablist"><button className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>待办</button><button className={filter === "today" ? "is-active" : ""} onClick={() => setFilter("today")}>今天</button><button className={filter === "completed" ? "is-active" : ""} onClick={() => setFilter("completed")}>已完成</button></div>}
        <div className="todo-tag-filter">
          <Icon name="ListFilter" size={13} />
          <select aria-label="按标签筛选" value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}>
            <option value="">全部标签</option>
            {availableTags.map((tag) => <option key={normalizeTagForComparison(tag)} value={tag}>{tag}</option>)}
          </select>
        </div>

        <div className="todo-list">
          {filter === "trash" && deletedItems.length > 0 && (confirmPurge ? (
            <>
              <button className="todo-empty-trash is-confirming" onClick={() => { setConfirmPurge(false); void purgeDeleted(); }}>确认清空（不可恢复）</button>
              <button className="todo-empty-trash" onClick={() => setConfirmPurge(false)}>取消</button>
            </>
          ) : (
            <button className="todo-empty-trash" onClick={() => setConfirmPurge(true)}>清空回收站</button>
          ))}
          {visibleItems.length === 0 ? <div className="todo-empty">没有任务</div> : visibleItems.map((item) => (
            <div ref={(node) => { itemRefs.current[item.id] = node; }} className={`todo-item${item.status === "completed" ? " is-completed" : ""}${editingId === item.id ? " is-editing" : ""}${focusedTodoId === item.id ? " is-focused" : ""}${dragId === item.id ? " is-dragging" : ""}${dragOverId === item.id ? (dragOverBefore ? " is-drag-over-before" : " is-drag-over-after") : ""}`} key={item.id}>
              <div className={`todo-item-row${canDrag ? " is-draggable" : ""}`} draggable={canDrag} onDragStart={(event) => handleDragStart(event, item.id)} onDragOver={(event) => handleDragOver(event, item.id)} onDragEnd={() => void handleDragEnd()}><button className="todo-check" aria-label={filter === "trash" ? "Restore task" : item.status === "completed" ? "取消完成" : "完成任务"} onClick={() => filter === "trash" ? void undoDelete(item) : void toggleTodo(item)}><Icon name="Check" size={13} /></button><button className="todo-item-main" onClick={() => { if (editingId !== item.id) setExpandedId(expandedId === item.id ? null : item.id); }}><span className="todo-item-title">{item.title}</span><span className="todo-item-summary">{item.priority && item.priority !== "normal" && <span className={`todo-priority priority-${item.priority}`}>{item.priority === "urgent" ? "紧急" : item.priority === "high" ? "高" : "低"}</span>}{item.dueAt && <span className={`todo-due${new Date(item.dueAt) < new Date() && item.status === "active" ? " is-overdue" : ""}`}>{formatDue(item.dueAt)}</span>}</span></button><div className="todo-item-actions">{filter === "trash" ? <button className="todo-edit" aria-label="Restore task" onClick={() => void undoDelete(item)}><Icon name="Undo2" size={13} /></button> : <><button className={`todo-edit${activeFocusTodoId === item.id ? " is-active-focus" : ""}`} aria-label="Start focus" onClick={() => void startFocus(item.id)}><Icon name="Timer" size={13} /></button><button className="todo-edit" aria-label="编辑任务" onClick={() => startEditing(item)}><Icon name="Pencil" size={13} /></button><button className="todo-delete" aria-label="删除任务" onClick={() => void removeTodo(item.id)}><Icon name="Trash2" size={14} /></button></>}</div></div>
              {expandedId === item.id && (editingId === item.id ? <div className="todo-item-details todo-edit-fields"><input aria-label="编辑任务标题" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={500} /><textarea aria-label="编辑任务备注" value={editNotes} onChange={(event) => setEditNotes(event.target.value)} maxLength={2000} placeholder="备注（可选）" /><div className="todo-edit-grid"><select aria-label="编辑任务优先级" value={editPriority} onChange={(event) => setEditPriority(event.target.value as TodoPriority)}><option value="normal">普通优先级</option><option value="low">低优先级</option><option value="high">高优先级</option><option value="urgent">紧急</option></select><select aria-label="编辑任务重复" value={editRepeatRule} onChange={(event) => setEditRepeatRule(event.target.value as TodoRepeatRule)}><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="workdays">工作日</option></select><input aria-label="编辑任务标签" value={editTags} onChange={(event) => setEditTags(event.target.value)} placeholder="标签，用逗号分隔" /><select aria-label="编辑任务清单" value={editListId} onChange={(event) => setEditListId(event.target.value)}><option value="">无清单</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></div><div className="todo-date-row">{renderDateField("截止", editDueAt, setEditDueAt)}{renderDateField("提醒", editRemindAt, setEditRemindAt)}</div><div className="todo-edit-buttons"><button onClick={() => void saveEditing(item.id)}>保存</button><button onClick={() => { setEditingId(null); setExpandedId(null); }}>取消</button></div></div> : <div className="todo-item-details">{item.notes && <div>{item.notes}</div>}{item.remindAt ? `提醒 ${formatDue(item.remindAt)}` : "未设置提醒"}</div>)}
            </div>
          ))}
        </div>
        {lastReminder && <div className="todo-reminder-toast" role="alert">
          <div className="todo-reminder-head">
            <button className="todo-reminder-focus" onClick={() => focusTodo(lastReminder.id)}>{lastReminder.title}</button>
            <button className="todo-reminder-close" aria-label="关闭提醒" onClick={() => setLastReminder(null)}><Icon name="X" size={13} /></button>
          </div>
          {showSnoozePicker ? <div className="todo-reminder-custom">
            <input aria-label="自定义延后时间" type="datetime-local" value={snoozeAt} min={localDateTime(new Date())} onChange={(event) => setSnoozeAt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void snoozeTodoAt(lastReminder.id, snoozeAt); }} />
            <button onClick={() => void snoozeTodoAt(lastReminder.id, snoozeAt)}>确定</button>
            <button onClick={() => setShowSnoozePicker(false)}>取消</button>
          </div> : <div className="todo-reminder-snooze">
            <span>延后：</span>
            {[5, 10, 30].map((minutes) => <button key={minutes} onClick={() => void snoozeTodo(lastReminder.id, minutes)}>{minutes}分</button>)}
            <button onClick={() => void snoozeTodo(lastReminder.id, 60)}>1小时</button>
            <button onClick={() => void snoozeTodoAt(lastReminder.id, dateAt(1, 9))}>明天 9:00</button>
            <button onClick={openSnoozePicker}>自定义</button>
          </div>}
        </div>}
        {undoItem && <div className="todo-undo-toast" role="status"><span>任务已删除</span><button onClick={() => void undoDelete()}>撤销</button></div>}
        {ioMessage && <div className="todo-io-toast" role="status">{ioMessage}<button aria-label="Dismiss message" onClick={() => setIoMessage("")}><Icon name="X" size={12} /></button></div>}
      </div>
    </div>
  );
}

export default TodoTool;
