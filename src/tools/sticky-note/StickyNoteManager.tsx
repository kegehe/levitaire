import { useCallback, useEffect, useLayoutEffect, useState } from "react";
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
import { getNoteColor } from "./constants";
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
    void invoke("create_sticky_note", { colorId: "yellow" }).catch((err) =>
      console.error("新建便利贴失败:", err),
    );
  };

  const showNote = (id: string) => {
    void invoke("show_sticky_note", { id }).catch((err) =>
      console.error("唤出便利贴失败:", err),
    );
  };

  const collectNote = (id: string) => {
    void invoke("collect_sticky_note", { id }).catch((err) =>
      console.error("收起便利贴失败:", err),
    );
  };

  const deleteNote = (id: string) => {
    void invoke("delete_sticky_note", { id }).catch((err) =>
      console.error("删除便利贴失败:", err),
    );
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
              const preview = note.content.trim().split("\n")[0] || "空白便利贴";
              const empty = note.content.trim().length === 0;
              return (
                <li
                  key={note.id}
                  className={`snm-item ${note.visible ? "" : "is-hidden"}`}
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
                      <span className="snm-meta">
                        {note.visible ? "已贴在桌面" : "已收起"}
                        {note.updatedAt ? ` · ${formatTime(note.updatedAt)}` : ""}
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
                      className="snm-icon-btn is-danger"
                      title="彻底删除"
                      aria-label="删除该便签"
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
