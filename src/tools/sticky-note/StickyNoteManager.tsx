import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import ToolIcon from "../../components/ToolIcon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import { clampWindowToWorkArea } from "../../utils/panelWindow";
import { getNoteColor, stripImgTokens } from "./constants";
import "./StickyNoteManager.css";

/**
 * 管理窗几何：面板定宽，高度随内容。
 *
 * ⚠️ 两侧必须同步（改动一处就要改另一处）：
 *   1. CSS `.snm-window { padding: 14px 14px 28px }`（= 下面三个留白）；
 *   2. 本文件的常量（把面板实测高度换算成窗口高度）。
 * 反面清单：Rust `commands/sticky.rs` 里**不能**再出现写死尺寸的 `set_size`（会把这里
 * 算好的高度在显示瞬间打回固定值）；CSS 里**不能**给 `.snm-window` / `.snm-panel` 写
 * `height: 100vh/100%`（面板撑满窗口 → 实测高度 = 窗口高度 → 越测越大）。
 * 面板宽 332 = 窗口宽 360 − 左右留白各 14。
 */
const MANAGER_PANEL_WIDTH = 332;
/** 投影留白：`.snm-panel` 的 box-shadow 是 `0 12px 28px` —— 左右各需 14，底部需要
 *  12 + 14 = 26（取 28 留一点余量），顶部取与左右同值让面板在窗口里视觉居中。 */
const MANAGER_MARGIN_X = 14;
const MANAGER_MARGIN_TOP = 14;
const MANAGER_MARGIN_BOTTOM = 28;
const MANAGER_WINDOW_WIDTH = MANAGER_PANEL_WIDTH + MANAGER_MARGIN_X * 2;

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
  // getCurrentWebviewWindow() 每次调用返回新对象，仅取首次值保证拖拽回调引用稳定
  const winRef = useRef(getCurrentWebviewWindow());
  const win = winRef.current;
  const panelRef = useRef<HTMLElement | null>(null);
  // 已下发的窗口尺寸（w:h）。重复下发同一尺寸会让窗口反复重排，故先去重。
  const lastWindowSizeRef = useRef("");
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [loading, setLoading] = useState(true);
  // 读取失败的原因。**非空时 `notes` 不是"没有便签"的意思**，界面必须说"读取失败"：
  // 照旧走空状态会显示成「还没有便利贴」，用户会以为便签被清空了（磁盘上其实还在）。
  const [loadError, setLoadError] = useState<string | null>(null);
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

  /**
   * 窗口高度随内容走。
   *
   * 面板高度本来就是可变的：空状态只有图标 + 一行字 + 一个小按钮，便签多时由
   * `.snm-list` 的 max-height 收口。窗口却是固定尺寸的无边框窗，所以必须把
   * 「面板实测高度 + 上下投影留白」写回窗口 —— 否则内容少时窗口照旧很高，空状态
   * 被 flex 居中推到一大片空白中央（旧版固定 560 就是这样）。
   *
   * 面板自身不能是 height: 100%（见 CSS）：那样测出来的高度就是窗口高度，窗口只会
   * 越调越大。这里量的是面板的自然高度，窗口尺寸反过来不影响它，所以不会震荡。
   * 用 ResizeObserver 而不是只跟着 notes 变化跑一次：便签预览换行、摘要行增减、
   * 删除确认文案变长都会改高度。
   *
   * 加载态（只有一行「加载中…」）刻意不量：那时量出来会把窗口先压成一条窄窗，数据
   * 一到再弹回来，开窗时能看见两次跳变。让窗口停在创建时的占位高度，只跳一次。
   */
  useLayoutEffect(() => {
    if (loading) return;
    const panel = panelRef.current;
    if (!panel) return;
    const resizeToContent = () => {
      const panelHeight = Math.ceil(panel.getBoundingClientRect().height);
      // 0 = 还没布局（测试环境不做布局），此时下发会把窗口压成一条
      if (panelHeight <= 0) return;
      const windowHeight = panelHeight + MANAGER_MARGIN_TOP + MANAGER_MARGIN_BOTTOM;
      const size = `${MANAGER_WINDOW_WIDTH}:${windowHeight}`;
      if (size === lastWindowSizeRef.current) return;
      lastWindowSizeRef.current = size;
      win
        .setSize(new LogicalSize(MANAGER_WINDOW_WIDTH, windowHeight))
        .catch((err) => console.error("调整便利贴管理窗尺寸失败:", err));
      // 便签数量变化会改窗口高度，贴屏幕下沿时要重新夹回工作区
      clampWindowToWorkArea(MANAGER_WINDOW_WIDTH, windowHeight);
    };

    resizeToContent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [win, loading, notes.length]);

  // 记忆窗口位置：拖拽后自动保存，重开恢复
  useEffect(() => persistWindowPositionOnMove("sticky-notes-manager"), []);

  /**
   * 按住标题栏拖动本窗。
   *
   * 管理窗是 `decorations: false` 的无边框窗，没有原生标题栏；此处不挂拖拽面时，
   * 整窗**完全无法移动**（位置记忆也就永远只记得创建时的坐标）。用显式
   * startDragging()，与便签窗一致，而不是 data-tauri-drag-region 属性——后者的
   * 双击由 Tauri 转成 internal_toggle_maximize，会把这块定宽面板双击顶成整屏。
   * 标题栏里的「新建 / 唤出全部 / 收起全部 / 隐藏」是点击目标，命中按钮时不拖。
   * 失败要出声：静默吞掉异常时，「拖不动」在日志里查不到任何痕迹。
   */
  const startPanelDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    win.startDragging().catch((err) => console.error("拖动便利贴管理窗失败:", err));
  };

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<StickyNote[]>("get_sticky_notes");
      setNotes(list);
      setLoadError(null);
    } catch (err) {
      // 失败不能只留一行控制台日志：列表保持上一轮内容（可能为空），由 loadError
      // 决定界面说"读取失败"还是"还没有便利贴"。
      console.error("读取便利贴列表失败:", err);
      setLoadError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 读取失败后的重试：先回到加载态，避免连点期间停在旧报错上没有任何反馈 */
  const retryLoad = useCallback(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

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
      <section className="snm-panel" ref={panelRef} aria-label="便利贴管理">
        <header className="snm-header" onMouseDown={startPanelDrag}>
          <div className="snm-title">
            <ToolIcon name="StickyNote" size={15} />
            <span>便利贴</span>
            {notes.length > 0 && <span className="snm-count">{notes.length}</span>}
          </div>
          <div className="snm-header-actions">
            <button
              type="button"
              className="snm-icon-btn is-brand"
              title="新建便利贴"
              aria-label="新建便利贴"
              onClick={createNote}
            >
              <Icon name="Plus" size={16} />
            </button>
            {/* 与「收起全部」成对：放出（Maximize2，箭头朝外）在前、收起（Minimize2，箭头
                朝内）在后，两个图标互为反向，读起来就是一组「批量放出 / 批量收回」。
                各自按「有没有对应目标的便签」置灰 —— 没有已收起的便签时放出是空操作。 */}
            <button
              type="button"
              className="snm-icon-btn"
              title="把所有已收起的便利贴贴回桌面"
              aria-label="唤出全部便利贴"
              disabled={hiddenCount === 0}
              onClick={() => {
                cancelConfirmDelete();
                void invoke("show_all_notes").catch((err) => console.error("唤出全部失败:", err));
              }}
            >
              <Icon name="Maximize2" size={15} />
            </button>
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

        {/* 刷新失败但手里还留着上一轮列表时，不清空、也不装作没事：继续显示旧数据，
            同时说清「这可能是过时的」—— 张数不一定准，用户不该被一个安静的数字骗到。
            放在摘要行**之前**：要过时的正是下面那些数字和条目，提示必须在它们上面。 */}
        {!loading && loadError && notes.length > 0 && (
          <div className="snm-error-note" role="alert">
            列表刷新失败，下面显示的内容可能已经过时：{loadError}
          </div>
        )}

        {/* 摘要行只在有便签时出现："桌面 0 张" 是纯噪声，还会把空状态顶下去 */}
        {notes.length > 0 && (
          <div className="snm-summary">
            {/* 分隔符只跟随第二段：写成 `pinnedCount > 0 && hiddenCount > 0` 时，
                全部收起（pinnedCount=0）会拼成「桌面 0 张已收起 3 张」的连读。 */}
            桌面 {pinnedCount} 张{hiddenCount > 0 ? " · " : ""}
            {hiddenCount > 0 ? `已收起 ${hiddenCount} 张` : ""}
          </div>
        )}

        {loading ? (
          <div className="snm-empty">加载中…</div>
        ) : loadError && notes.length === 0 ? (
          /* ★ 读不出来就说读不出来。这里**必须**先于空状态判定：一旦落到下一分支，
             界面会显示「还没有便利贴 / 新建第一张」，用户读了会以为便签被清空了。
             「内容暂未加载」这半句与单张便签窗的失败卡片（StickyNote.tsx）同一措辞 ——
             同一个功能、同一种失败，两处说法不该各写一套。 */
          <div className="snm-empty is-error" role="alert">
            <ToolIcon name="StickyNote" size={24} />
            <p>读取便利贴列表失败，内容暂未加载</p>
            <p className="snm-error-detail" title={loadError}>
              {loadError}
            </p>
            <button type="button" className="snm-add-btn" onClick={retryLoad}>
              重试
            </button>
          </div>
        ) : notes.length === 0 ? (
          <div className="snm-empty">
            <ToolIcon name="StickyNote" size={24} />
            <p>还没有便利贴</p>
            <button type="button" className="snm-add-btn" onClick={createNote}>
              <Icon name="Plus" size={14} />
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
      </section>
    </div>
  );
}

export default StickyNoteManager;
