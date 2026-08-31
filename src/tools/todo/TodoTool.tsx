import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import { applyThemePreferences, getStoredThemePreferences, subscribeThemePreferences } from "../../styles/themePreferences";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import { ensurePomodoroWindow } from "../../utils/toolWindows";
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
const INBOX_LIST_ID = "inbox";

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

const displayListName = (list: TodoList) => list.id === INBOX_LIST_ID ? "收件箱" : list.name;
const hasItemDetails = (item: TodoItem) => Boolean(
  item.notes
  || item.remindAt
  || (item.tags?.length ?? 0) > 0
  || (item.repeatRule && item.repeatRule !== "none")
  || (item.priority && item.priority !== "normal"),
);

function TodoTool() {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [deletedItems, setDeletedItems] = useState<TodoItem[]>([]);
  const [lists, setLists] = useState<TodoList[]>([]);
  const [selectedListId, setSelectedListId] = useState(INBOX_LIST_ID);
  const [newListName, setNewListName] = useState("");
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editListName, setEditListName] = useState("");
  const [confirmDeleteListId, setConfirmDeleteListId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<"all" | "today" | "completed" | "trash">("all");
  const [sortMode, setSortMode] = useState<"priority" | "manual">("priority");
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
  const [expandedId, setExpandedIdState] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editPriority, setEditPriority] = useState<TodoPriority>("normal");
  const [editRepeatRule, setEditRepeatRule] = useState<TodoRepeatRule>("none");
  const [editTags, setEditTags] = useState("");
  const [editListId, setEditListId] = useState(INBOX_LIST_ID);
  const [editDueAt, setEditDueAt] = useState("");
  const [editRemindAt, setEditRemindAt] = useState("");
  const [undoItem, setUndoItem] = useState<TodoItem | null>(null);
  const [lastReminder, setLastReminder] = useState<TodoItem | null>(null);
  const [activeFocusTodoId, setActiveFocusTodoId] = useState<string | null>(null);
  const [focusedTodoId, setFocusedTodoId] = useState<string | null>(null);
  const [ioMessage, setIoMessage] = useState("");
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const itemsRef = useRef<TodoItem[]>([]);
  itemsRef.current = items;
  const setExpandedId = useCallback((value: string | null) => {
    const target = value ? itemsRef.current.find((item) => item.id === value) : undefined;
    if (target && !hasItemDetails(target)) return;
    setExpandedIdState(value);
  }, []);
  const win = useMemo(() => getCurrentWebviewWindow(), []);

  const refresh = useCallback(() => {
    void invoke<TodoItem[]>("get_todos", { includeCompleted: true, sortMode }).then((value) => setItems(Array.isArray(value) ? value : [])).catch(console.error);
    void invoke<TodoItem[]>("get_deleted_todos").then((value) => setDeletedItems(Array.isArray(value) ? value : [])).catch(console.error);
    void invoke<TodoList[]>("get_todo_lists").then((value) => {
      const next = Array.isArray(value) ? value : [];
      setLists(next);
      setSelectedListId((current) => next.some((list) => list.id === current) ? current : (next[0]?.id ?? INBOX_LIST_ID));
    }).catch(console.error);
  }, [sortMode]);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) { root.style.background = "transparent"; root.style.margin = "0"; root.style.height = "100%"; }
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
    const focusAdd = listen("todo-focus-add", () => {
      window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    });
    const focusItem = listen<TodoFocusPayload>("todo-focus-item", (event) => {
      const id = event.payload.todoId ?? event.payload.itemId;
      if (!id) return;
      const target = itemsRef.current.find((item) => item.id === id);
      if (target) {
        setSelectedListId(target.listId ?? INBOX_LIST_ID);
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
      focusAdd.then((fn) => fn()).catch(console.error);
      focusItem.then((fn) => fn()).catch(console.error);
      pomodoroTick.then((fn) => fn()).catch(console.error);
    };
  }, [refresh]);

  useEffect(() => persistWindowPositionOnMove("todo-overlay"), []);

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  const addTodo = async () => {
    const value = title.trim();
    if (!value) return;
    try {
      const input: Record<string, unknown> = { title: value, priority, tags: tags.split(","), dueAt: toIso(dueAt), remindAt: toIso(remindAt) };
      if (repeatRule !== "none") input.repeatRule = repeatRule;
      if (selectedListId !== INBOX_LIST_ID) input.listId = selectedListId;
      await invoke("create_todo", { input });
      setTitle(""); setTags(""); setPriority("normal"); setRepeatRule("none"); setDueAt(""); setRemindAt(""); setShowAddOptions(false); refresh(); inputRef.current?.focus();
    } catch (error) { console.error("create todo failed", error); setIoMessage("添加任务失败"); }
  };

  const createList = async () => {
    const name = newListName.trim();
    if (!name) return;
    try {
      const list = await invoke<TodoList>("create_todo_list", { input: { name } });
      setNewListName("");
      if (list?.id) setSelectedListId(list.id);
      refresh();
    } catch (error) { console.error("create todo list failed", error); setIoMessage("创建清单失败"); }
  };

  const saveListName = async (id: string) => {
    const name = editListName.trim();
    if (!name || id === INBOX_LIST_ID) return;
    try { await invoke("update_todo_list", { id, input: { name } }); setEditingListId(null); refresh(); }
    catch (error) { console.error("update todo list failed", error); setIoMessage("重命名清单失败"); }
  };

  const deleteList = async (id: string) => {
    if (id === INBOX_LIST_ID) return;
    try { await invoke("delete_todo_list", { id }); setConfirmDeleteListId(null); setSelectedListId(INBOX_LIST_ID); refresh(); }
    catch (error) { console.error("delete todo list failed", error); setIoMessage("删除清单失败"); }
  };

  const purgeDeleted = async () => {
    try { await invoke("purge_deleted_todos"); refresh(); }
    catch (error) { console.error("purge deleted todos failed", error); setIoMessage("清空回收站失败"); }
  };

  const exportTodos = async () => {
    try { if (await invoke<boolean>("export_todos")) setIoMessage("Exported"); }
    catch (error) { console.error("export todos failed", error); setIoMessage("Export failed"); }
  };

  const importTodos = async () => {
    try { if (await invoke<boolean>("import_todos")) { setIoMessage("Imported"); refresh(); } }
    catch (error) { console.error("import todos failed", error); setIoMessage("Import failed"); }
  };

  const reorderTodo = async (id: string, direction: -1 | 1) => {
    try { await invoke("reorder_todos", { id, direction }); refresh(); }
    catch (error) { console.error("reorder todo failed", error); setIoMessage("调整顺序失败"); }
  };

  const startFocus = async (id: string) => {
    try {
      await invoke("start_pomodoro_for_todo", { todoId: id });
      setActiveFocusTodoId(id);
      await ensurePomodoroWindow();
      await invoke("show_pomodoro_window");
    } catch (error) { console.error("start todo focus failed", error); setIoMessage("启动专注失败"); }
  };

  const toggleTodo = async (item: TodoItem) => {
    try { await invoke("set_todo_completed", { id: item.id, completed: item.status !== "completed" }); refresh(); }
    catch (error) { console.error("update todo failed", error); setIoMessage("更新任务失败"); }
  };

  const removeTodo = async (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    try { await invoke("delete_todo", { id }); refresh(); }
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
    try { await invoke("restore_todo", { id: item.id }); refresh(); }
    catch (error) { console.error("restore todo failed", error); setIoMessage("恢复任务失败"); }
  };

  const snoozeTodo = async (id: string, minutes: number) => {
    try {
      await invoke("snooze_todo", { id, minutes });
      setLastReminder(null);
      refresh();
    } catch (error) { console.error("snooze todo failed", error); setIoMessage("延后提醒失败"); }
  };

  const focusTodo = useCallback((id: string) => {
    const target = items.find((item) => item.id === id) ?? (lastReminder?.id === id ? lastReminder : undefined);
    if (target) {
      setSelectedListId(target.listId ?? INBOX_LIST_ID);
      setFilter(target.status === "completed" ? "completed" : "all");
    }
    setQuery("");
    setExpandedId(id);
    setFocusedTodoId(id);
    setLastReminder(null);
  }, [items, lastReminder]);

  const startEditing = (item: TodoItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditNotes(item.notes ?? "");
    setEditPriority(item.priority ?? "normal");
    setEditRepeatRule(item.repeatRule ?? "none");
    setEditTags((item.tags ?? []).join(", "));
    setEditListId(item.listId ?? INBOX_LIST_ID);
    setEditDueAt(toLocalInput(item.dueAt));
    setEditRemindAt(toLocalInput(item.remindAt));
    setExpandedIdState(item.id);
  };

  const saveEditing = async (id: string) => {
    const value = editTitle.trim();
    if (!value) return;
    try {
      await invoke("update_todo", {
        id,
        input: { title: value, notes: editNotes, priority: editPriority, repeatRule: editRepeatRule, tags: editTags.split(","), listId: editListId, dueAt: toIso(editDueAt) ?? null, remindAt: toIso(editRemindAt) ?? null },
      });
      setEditingId(null);
      refresh();
    } catch (error) { console.error("edit todo failed", error); setIoMessage("保存任务失败"); }
  };

  const visibleItems = (filter === "trash" ? deletedItems : items).filter((item) => {
    const normalized = query.trim().toLowerCase();
    const matchesQuery = !normalized || item.title.toLowerCase().includes(normalized) || (item.notes ?? "").toLowerCase().includes(normalized) || (item.tags ?? []).some((tag) => tag.toLowerCase().includes(normalized));
    if (filter !== "trash" && (item.listId ?? INBOX_LIST_ID) !== selectedListId) return false;
    if (filter === "trash") return matchesQuery;
    if (filter === "completed") return item.status === "completed" && matchesQuery;
    if (filter === "today") {
      if (!item.dueAt) return false;
      const date = new Date(item.dueAt); const now = new Date();
      return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate() && item.status === "active" && matchesQuery;
    }
    if (item.status !== "active") return false;
    return matchesQuery;
  });

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
    <div className="todo-container">
      <div className="todo-body">
        <div className="todo-titlebar" onMouseDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button")) { event.preventDefault(); void win.startDragging(); } }}>
          <span className="todo-title">待办清单</span>
          <span className="todo-count">{items.filter((item) => item.status === "active" && (item.listId ?? INBOX_LIST_ID) === selectedListId).length}</span>
          <button className={`todo-icon-btn${showSearch ? " is-active" : ""}`} aria-label="搜索任务" title="搜索任务" onClick={() => { setShowSearch((value) => !value); setShowMore(false); }}><Icon name="Search" size={14} /></button>
          <button className={`todo-icon-btn${showMore ? " is-active" : ""}`} aria-label="更多操作" title="更多操作" onClick={() => { setShowMore((value) => !value); setShowSearch(false); }}><Icon name="Settings" size={14} /></button>
          <button className="todo-icon-btn" aria-label="关闭待办清单" title="关闭待办清单" onClick={() => void invoke("hide_todo_window")}><Icon name="X" size={14} /></button>
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

        {filter !== "trash" && <div className="todo-list-bar"><select aria-label="Todo list" value={selectedListId} onChange={(event) => { setSelectedListId(event.target.value); setFilter("all"); }}>{lists.map((list) => <option key={list.id} value={list.id}>{displayListName(list)}</option>)}</select><button className={`todo-list-manage-btn${showListManager ? " is-active" : ""}`} aria-label="管理清单" title="管理清单" onClick={() => setShowListManager((value) => !value)}><Icon name="ListOrdered" size={14} /></button></div>}
        {filter !== "trash" && showListManager && <div className="todo-list-manager">
          <div className="todo-list-create"><input aria-label="New list name" value={newListName} onChange={(event) => setNewListName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createList(); }} placeholder="新建清单" maxLength={80} /><button className="todo-list-action" aria-label="Create list" onClick={() => void createList()}><Icon name="Plus" size={14} /></button></div>
          {selectedListId !== INBOX_LIST_ID && <div className="todo-list-edit"><span>{lists.find((list) => list.id === selectedListId)?.name}</span>{editingListId === selectedListId ? <><input aria-label="Edit list name" value={editListName} onChange={(event) => setEditListName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveListName(selectedListId); }} /><button className="todo-list-action" aria-label="Save list name" title="保存清单名称" onClick={() => void saveListName(selectedListId)}><Icon name="Check" size={14} /></button></> : <button className="todo-list-action" aria-label="Rename list" title="重命名清单" onClick={() => { setEditingListId(selectedListId); setEditListName(lists.find((list) => list.id === selectedListId)?.name ?? ""); }}><Icon name="Pencil" size={14} /></button>}{confirmDeleteListId === selectedListId ? <><button className="todo-list-action" aria-label="Confirm delete list" title="确认删除清单" onClick={() => void deleteList(selectedListId)}><Icon name="Check" size={14} /></button><button className="todo-list-action" aria-label="Cancel delete list" title="取消删除" onClick={() => setConfirmDeleteListId(null)}><Icon name="X" size={14} /></button></> : <button className="todo-list-action" aria-label="Delete list" title="删除清单" onClick={() => setConfirmDeleteListId(selectedListId)}><Icon name="Trash2" size={14} /></button>}</div>}
        </div>}
        {showSearch && <div className="todo-search"><Icon name="Search" size={14} /><input autoFocus aria-label="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务标题、备注或标签" /></div>}

        {filter === "trash" ? <div className="todo-trash-state"><span><Icon name="Trash2" size={13} />回收站</span><button onClick={() => setFilter("all")}>返回待办</button></div> : <div className="todo-filters" role="tablist"><button className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>待办</button><button className={filter === "today" ? "is-active" : ""} onClick={() => setFilter("today")}>今天</button><button className={filter === "completed" ? "is-active" : ""} onClick={() => setFilter("completed")}>已完成</button></div>}

        <div className="todo-list">
          {filter === "trash" && deletedItems.length > 0 && <button className="todo-empty-trash" onClick={() => void purgeDeleted()}>清空回收站</button>}
          {visibleItems.length === 0 ? <div className="todo-empty">没有任务</div> : visibleItems.map((item) => (
            <div ref={(node) => { itemRefs.current[item.id] = node; }} className={`todo-item${item.status === "completed" ? " is-completed" : ""}${focusedTodoId === item.id ? " is-focused" : ""}`} key={item.id}>
              <div className="todo-item-row"><button className="todo-check" aria-label={filter === "trash" ? "Restore task" : item.status === "completed" ? "取消完成" : "完成任务"} onClick={() => filter === "trash" ? void undoDelete(item) : void toggleTodo(item)}><Icon name="Check" size={13} /></button><button className="todo-item-main" onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}><span className="todo-item-title">{item.title}</span><span className="todo-item-summary">{item.priority && item.priority !== "normal" && <span className={`todo-priority priority-${item.priority}`}>{item.priority === "urgent" ? "紧急" : item.priority === "high" ? "高" : "低"}</span>}{item.dueAt && <span className={`todo-due${new Date(item.dueAt) < new Date() && item.status === "active" ? " is-overdue" : ""}`}>{formatDue(item.dueAt)}</span>}</span></button><div className="todo-item-actions">{filter === "trash" ? <button className="todo-edit" aria-label="Restore task" onClick={() => void undoDelete(item)}><Icon name="Undo2" size={13} /></button> : <><button className={`todo-edit${activeFocusTodoId === item.id ? " is-active-focus" : ""}`} aria-label="Start focus" onClick={() => void startFocus(item.id)}><Icon name="Timer" size={13} /></button><button className="todo-edit" aria-label="编辑任务" onClick={() => startEditing(item)}><Icon name="Pencil" size={13} /></button>{sortMode === "manual" && <div className="todo-reorder-actions"><button className="todo-edit" aria-label="Move task up" onClick={() => void reorderTodo(item.id, -1)}><Icon name="ArrowUp" size={12} /></button><button className="todo-edit" aria-label="Move task down" onClick={() => void reorderTodo(item.id, 1)}><Icon name="ArrowDown" size={12} /></button></div>}<button className="todo-delete" aria-label="删除任务" onClick={() => void removeTodo(item.id)}><Icon name="Trash2" size={14} /></button></>}</div></div>
              {expandedId === item.id && (editingId === item.id ? <div className="todo-item-details todo-edit-fields"><input aria-label="编辑任务标题" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={500} /><textarea aria-label="编辑任务备注" value={editNotes} onChange={(event) => setEditNotes(event.target.value)} maxLength={2000} placeholder="备注（可选）" /><div className="todo-edit-grid"><select aria-label="编辑任务优先级" value={editPriority} onChange={(event) => setEditPriority(event.target.value as TodoPriority)}><option value="normal">普通优先级</option><option value="low">低优先级</option><option value="high">高优先级</option><option value="urgent">紧急</option></select><select aria-label="编辑任务重复" value={editRepeatRule} onChange={(event) => setEditRepeatRule(event.target.value as TodoRepeatRule)}><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="workdays">工作日</option></select><input aria-label="编辑任务标签" value={editTags} onChange={(event) => setEditTags(event.target.value)} placeholder="标签，用逗号分隔" /><select aria-label="编辑任务清单" value={editListId} onChange={(event) => setEditListId(event.target.value)}>{lists.map((list) => <option key={list.id} value={list.id}>{displayListName(list)}</option>)}</select></div><div className="todo-date-row">{renderDateField("截止", editDueAt, setEditDueAt)}{renderDateField("提醒", editRemindAt, setEditRemindAt)}</div><div className="todo-edit-buttons"><button onClick={() => void saveEditing(item.id)}>保存</button><button onClick={() => { setEditingId(null); setExpandedId(null); }}>取消</button></div></div> : <div className="todo-item-details">{item.notes && <div>{item.notes}</div>}{item.remindAt ? `提醒 ${formatDue(item.remindAt)}` : "未设置提醒"}</div>)}
            </div>
          ))}
        </div>
        {lastReminder && <div className="todo-reminder-toast" role="alert">
          <button className="todo-reminder-focus" onClick={() => focusTodo(lastReminder.id)}>{lastReminder.title}</button>
          <div>
            {[5, 10, 30].map((minutes) => <button key={minutes} onClick={() => void snoozeTodo(lastReminder.id, minutes)}>{minutes}分后</button>)}
            <button aria-label="关闭提醒" onClick={() => setLastReminder(null)}><Icon name="X" size={13} /></button>
          </div>
        </div>}
        {undoItem && <div className="todo-undo-toast" role="status"><span>任务已删除</span><button onClick={() => void undoDelete()}>撤销</button></div>}
        {ioMessage && <div className="todo-io-toast" role="status">{ioMessage}<button aria-label="Dismiss message" onClick={() => setIoMessage("")}><Icon name="X" size={12} /></button></div>}
      </div>
    </div>
  );
}

export default TodoTool;
