import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../styles/themePreferences";
import type { UpdateSnapshot } from "../hooks/useUpdater";
import "./UpdatePrompt.css";

/**
 * 更新就绪提示窗。
 *
 * 只在**安装包已下载完成并验签落盘**之后出现 —— 后端在 `mark_ready` 时才 show 本窗
 * （静默升级：下载阶段完全不打扰用户）。因此这里没有进度条：点「立即更新」时下载
 * 早已结束，安装几乎是立刻开始的。
 */
function UpdatePrompt() {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // getCurrentWebviewWindow() 每次调用都返回新对象，放进依赖数组会让 effect 每渲染重跑
  // （见 developer-guide 最佳实践 8），拿到就 memo 住。
  const appWindow = useMemo(() => getCurrentWebviewWindow(), []);

  // 竞态：卸载后忽略过期异步结果
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // ① 监听后端状态变化
    // ② 启动时兜底拉一次快照：窗口是后端在就绪那一刻 show 出来的，事件很可能早于
    //    本窗口的监听器注册，只靠事件会永远等不到。
    let unlisten: (() => void) | undefined;
    let disposed = false;
    // 若监听器已经收到过事件，手里这份快照可能是旧的（例如 invoke 往返期间后端
    // 又发现了更新的版本并开始下载），回填会把窗口挂在过期版本上。
    let sawEvent = false;
    const init = async () => {
      const [un, current] = await Promise.all([
        listen<UpdateSnapshot>("update-status", (event) => {
          sawEvent = true;
          if (mountedRef.current) setSnapshot(event.payload);
        }),
        invoke<UpdateSnapshot>("get_update_status"),
      ]);
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      if (!sawEvent && mountedRef.current) setSnapshot(current);
    };
    init().catch((error) => {
      console.error("update prompt init failed:", error);
      // 拿不到快照就什么都不渲染，而窗口已被后端 show 出来 —— 那会留下一个空的
      // 透明层把下面的点击全挡住。失败时主动收回去，宁可这次不提示。
      appWindow.hide().catch(() => {});
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow]);

  // 首帧即时着色：更新提示是独立窗口，避免深色主题下先渲染一帧浅色再被纠正
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    // 四周留出投影留白（见 utils/panelWindow.ts 与 UpdatePrompt.css）：
    // 窗口尺寸由 Rust 侧算成「面板 + 2×留白」，留白供卡片投影展开，否则投影会被
    // 窗口边界硬切成卡片四角的直角残影。
    document.body.classList.add("update-prompt-window");
    return () => {
      document.body.classList.remove("update-prompt-window");
    };
  }, []);

  useEffect(() => {
    // 应用当前主题配色，并在窗口显示期间跟随主题变更
    let disposeTheme: (() => void) | undefined;
    let disposed = false;
    subscribeThemePreferences().then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        disposeTheme = unlisten;
      }
    });
    return () => {
      disposed = true;
      disposeTheme?.();
    };
  }, []);

  // `idle` / `downloading` 时本组件渲染 null，窗口若还留着就是一个空的透明层，
  // 会挡住下面所有点击 —— 必须收回去。
  //
  // ⚠️ `failed` 有意**不**收：用户刚在本窗点了「立即更新」，失败原因必须留在眼前。
  // 这里渲染的是一张不透明的失败卡，不存在透明遮挡问题；而窗口本就被后端收着
  // （只有 ready 时才会 show），若此刻它是隐藏的，渲染出来也看不见，不会变成弹窗。
  useEffect(() => {
    if (snapshot && (snapshot.phase === "idle" || snapshot.phase === "downloading")) {
      appWindow.hide().catch(console.error);
    }
  }, [snapshot, appWindow]);

  const handleInstall = async () => {
    if (installing) return;
    setInstalling(true);
    setError(null);
    try {
      await invoke("install_update");
      // install_update 会拉起安装器并退出本进程，正常路径走不到这里
    } catch (err) {
      if (mountedRef.current) {
        setError(typeof err === "string" ? err : String(err));
        setInstalling(false);
      }
    }
  };

  const handleDismiss = async () => {
    try {
      await invoke("dismiss_update");
    } catch (err) {
      console.error("Failed to dismiss update:", err);
    }
    if (mountedRef.current) {
      setError(null);
    }
    // 隐藏窗口（保留窗口以复用），下次有更新时由 Rust 端重新 show
    appWindow.hide().catch(console.error);
  };

  /**
   * 失败后重试：重新走一次后端检查（发现新版本会重新静默下载）。
   *
   * 后端在安装失败时会连缓存包一起清掉（缓存不可信），所以这里必然是一遍新的下载；
   * 状态转为 `downloading` 时上面的 effect 会把窗口收回去，下完再由后端 show 出来。
   */
  const handleRetry = async () => {
    setError(null);
    try {
      await invoke("check_for_updates");
    } catch (err) {
      if (mountedRef.current) {
        setError(typeof err === "string" ? err : String(err));
      }
    }
  };

  if (!snapshot) return null;
  // 没有可提示的内容（无更新 / 后台正在下载）：交给上面的 effect 把窗口收回去
  if (snapshot.phase === "idle" || snapshot.phase === "downloading") return null;

  if (snapshot.phase === "failed") {
    // 失败卡：本窗只在 ready 时被后端 show 出来，所以这张卡看到的时机就是
    // 「用户刚点过安装而失败了」—— 必须留下原因，不能像以前那样静默消失。
    return (
      <div className="update-prompt">
        <div className="update-prompt-header update-prompt-header-error">
          <Icon name="AlertCircle" size={16} />
          <span>更新未完成</span>
        </div>
        {snapshot.version && (
          <div className="update-prompt-version">Levitaire v{snapshot.version}</div>
        )}
        <div className="update-prompt-error">{snapshot.error ?? error ?? "安装未完成"}</div>
        <div className="update-prompt-actions">
          <button
            className="update-prompt-btn update-prompt-btn-primary"
            onClick={handleRetry}
          >
            <Icon name="RotateCcw" size={14} /> 重新下载
          </button>
          <button className="update-prompt-btn" onClick={handleDismiss}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="update-prompt">
      <div className="update-prompt-header">
        <Icon name="Rocket" size={16} />
        <span>新版本已就绪</span>
      </div>
      <div className="update-prompt-version">Levitaire v{snapshot.version}</div>
      {snapshot.notes && <div className="update-prompt-notes">{snapshot.notes}</div>}

      {installing ? (
        <div className="update-prompt-status">
          <Icon name="Loader2" size={14} className="update-prompt-spinner" />
          <span className="update-prompt-hint">正在安装，应用即将重启…</span>
        </div>
      ) : (
        <div className="update-prompt-actions">
          <button className="update-prompt-btn update-prompt-btn-primary" onClick={handleInstall}>
            <Icon name="Download" size={14} /> 立即更新
          </button>
          <button className="update-prompt-btn" onClick={handleDismiss}>
            稍后
          </button>
        </div>
      )}

      {error && <div className="update-prompt-error">{error}</div>}
    </div>
  );
}

export default UpdatePrompt;
