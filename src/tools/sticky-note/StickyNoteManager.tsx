import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Icon from "../../components/Icon";
import ToolIcon from "../../components/ToolIcon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import { getNoteColor, stripImgTokens } from "./constants";
import "./StickyNoteManager.css";

interface StickyNote {
  id: string;
  content: string;
  colorId: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function StickyNoteManager() {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [loading, setLoading] = useState(true);
  // 删除二次确认：记录当前待确认删除的便利贴 id，3 秒内再次点击才真正删除
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimerRef = useRef<number | null>(null);

  /** 退出删除确认态（清理倒计时） */
  const cancelConfirmDelete = useCallback(() => {
    if (confirmTimerRef.current !== null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmDeleteId(null);
  }, []);

  // 卸载时清理倒计时
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    };
  }, []);

  // 列表刷新后目标已不存在（如在便签窗被删）时，兜底退出确认态
  useEffect(() => {
    if (confirmDeleteId !== null && !notes.some((note) => note.id === confirmDeleteId)) {
      cancelConfirmDelete();
    }
  }, [notes, confirmDeleteId, cancelConfirmDelete]);

  // 独立窗口：手动应用并订阅主题
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
  }, []);
  useEffect(() => {
    const un = subscribeThemePreferences();
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 记忆窗口位置：拖拽后自动保存，重开恢复
  useEffect(() => persistWindowPositionOnMove("sticky-notes-manager"), []);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<StickyNote[]>("get_sticky_notes");
      setNotes(list);
    } catch (err) {
      console.error("读取便利贴列表失败:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载：恢复所有"已钉在桌面"的便签窗口（若工具曾被禁用销毁过），并刷新列表
  useEffect(() => {
    let disposed = false;
    void invoke<number>("restore_pinned_notes").catch(() => {});
    void refresh();
    const un = listen("sticky-notes-changed", () => {
      if (!disposed) void refresh();
    });
    return () => {
      disposed = true;
      un.then((fn) => fn());
    };
  }, [refresh]);

  const createNote = () => {
    cancelConfirmDelete();
    void invoke("create_sticky_note", { colorId: "yellow" }).catch((err) =>
      console.error("新建便利贴失败:", err),
    );
  };

  const showNote = (id: string) => {
    cancelConfirmDelete();
    void invoke("show_sticky_note", { id }).catch((err) => console.error("唤出便利贴失败:", err));
  };

  const collectNote = (id: string) => {
    cancelConfirmDelete();
    void invoke("collect_sticky_note", { id }).catch((err) =>
      console.error("收起便利贴失败:", err),
    );
  };

  // 删除需二次确认（与单张便签一致）：首次点击进入待确认态并 3 秒超时复位，
  // 超时前再次点击同一行才真正删除。
  const deleteNote = (id: string) => {
    if (confirmDeleteId === id) {
      cancelConfirmDelete();
      void invoke("delete_sticky_note", { id }).catch((err) =>
        console.error("删除便利贴失败:", err),
      );
      return;
    }
    cancelConfirmDelete();
    setConfirmDeleteId(id);
    confirmTimerRef.current = window.setTimeout(() => setConfirmDeleteId(null), 3000);
  };

  const pinnedCount = notes.filter((note) => note.visible).length;
  const hiddenCount = notes.length - pinnedCount;

  return (
    <div className="snm-window">
      <section className="snm-panel" aria-label="便利贴管理">
        <header className="snm-header">
          <div className="snm-title">
            <ToolIcon name="StickyNote" size={15} />
            <span>便利贴</span>
            {notes.length > 0 && <span className="snm-count">{notes.length}</span>}
          </div>
          <div className="snm-header-actions">
            <button
              type="button"
              className="snm-icon-btn"
              title="收起全部已钉在桌面的便利贴"
              aria-label="收起全部便利贴"
              disabled={pinnedCount === 0}
              onClick={() => {
                cancelConfirmDelete();
                void invoke("collect_all_notes").catch((err) =>
                  console.error("收起全部失败:", err),
                );
              }}
            >
              <Icon name="Minimize2" size={15} />
            </button>
            <button
              type="button"
              className="snm-icon-btn"
              title="隐藏本窗口（便签仍保留）"
              aria-label="隐藏管理窗"
              onClick={() => {
                cancelConfirmDelete();
                void invoke("hide_sticky_notes_manager").catch(() => {});
              }}
            >
              <Icon name="X" size={15} />
            </button>
          </div>
        </header>

        <div className="snm-summary">
          桌面 {pinnedCount} 张{pinnedCount > 0 && hiddenCount > 0 ? " · " : ""}
          {hiddenCount > 0 ? `已收起 ${hiddenCount} 张` : ""}
        </div>

        {loading ? (
          <div className="snm-empty">加载中…</div>
        ) : notes.length === 0 ? (
          <div className="snm-empty">
            <ToolIcon name="StickyNote" size={34} />
            <p>还没有便利贴</p>
            <button type="button" className="snm-primary-btn" onClick={createNote}>
              新建第一张
            </button>
          </div>
        ) : (
          <ul className="snm-list">
            {notes.map((note) => {
              const color = getNoteColor(note.colorId);
              const firstLine = stripImgTokens(note.content.trim()).split("\n")[0] || "";
              const preview = firstLine || "空白便利贴";
              const empty = stripImgTokens(note.content.trim()).length === 0;
              return (
                <li
                  key={note.id}
                  className={`snm-item ${note.visible ? "" : "is-hidden"} ${confirmDeleteId === note.id ? "is-confirming" : ""}`}
                >
                  <button
                    type="button"
                    className="snm-item-main"
                    title={note.visible ? "点击到桌面聚焦该便签" : "点击在桌面重新打开"}
                    onClick={() => showNote(note.id)}
                  >
                    <span
                      className="snm-dot"
                      style={{ backgroundColor: color.swatch }}
                      aria-hidden="true"
                    />
                    <span className="snm-item-text">
                      <span className={`snm-preview ${empty ? "is-placeholder" : ""}`}>
                        {empty ? "空白便签" : preview}
                      </span>
                      <span
                        className={`snm-meta ${confirmDeleteId === note.id ? "is-danger-text" : ""}`}
                      >
                        {confirmDeleteId === note.id
                          ? "再点一次确认删除"
                          : `${note.visible ? "已贴在桌面" : "已收起"}${note.updatedAt ? ` · ${formatTime(note.updatedAt)}` : ""}`}
                      </span>
                    </span>
                  </button>
                  <span className="snm-item-actions">
                    {note.visible ? (
                      <button
                        type="button"
                        className="snm-icon-btn"
                        title="收起（数据保留）"
                        aria-label="收起该便签"
                        onClick={() => collectNote(note.id)}
                      >
                        <Icon name="EyeOff" size={14} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="snm-icon-btn"
                        title="重新贴到桌面"
                        aria-label="唤出该便签"
                        onClick={() => showNote(note.id)}
                      >
                        <Icon name="Eye" size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className={`snm-icon-btn is-danger ${confirmDeleteId === note.id ? "is-confirm" : ""}`}
                      title={confirmDeleteId === note.id ? "再点一次确认删除" : "彻底删除"}
                      aria-label={confirmDeleteId === note.id ? "确认删除该便签" : "删除该便签"}
                      onClick={() => deleteNote(note.id)}
                    >
                      <Icon name="Trash2" size={14} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {notes.length > 0 && (
          <footer className="snm-footer">
            <button type="button" className="snm-primary-btn" onClick={createNote}>
              <Icon name="Plus" size={15} />
              新建便利贴
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}

export default StickyNoteManager;
