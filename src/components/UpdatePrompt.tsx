import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import "./UpdatePrompt.css";

interface UpdateInfo {
  version: string;
  notes: string;
}

interface ProgressPayload {
  received: number;
  total: number | null;
}

function UpdatePrompt() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  // 下载中：progress 为 0..100 百分比，null 表示未知总量
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 竞态：卸载后忽略过期异步结果
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // ① 监听 Rust 后端发来的"发现新版本"事件
    // ② 启动时兜底查询后端已有版本（避免事件早于监听器注册而丢失）
    let unlisten: (() => void) | undefined;
    const init = async () => {
      const [un] = await Promise.all([
        listen<UpdateInfo>("update-available", (event) => {
          if (mountedRef.current) {
            setInfo(event.payload);
            setError(null);
          }
        }),
        invoke<UpdateInfo | null>("get_update_status").then((cur) => {
          if (cur && mountedRef.current) {
            setInfo(cur);
            setError(null);
          }
        }),
      ]);
      unlisten = un;
    };
    init().catch(console.error);
    return () => {
      unlisten?.();
    };
  }, []);

  // 下载进度事件
  useEffect(() => {
    let un: (() => void) | undefined;
    const setup = async () => {
      un = await listen<ProgressPayload>("update-progress", (event) => {
        if (!mountedRef.current) return;
        const { received, total } = event.payload;
        setProgress(
          total != null && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
        );
      });
    };
    setup().catch(console.error);
    return () => un?.();
  }, []);

  const handleInstall = async () => {
    if (downloading) return;
    setDownloading(true);
    setProgress(0);
    setError(null);
    try {
      await invoke("install_update");
      // install_update 成功后应用自身会重启，此处无需再操作
    } catch (err) {
      if (mountedRef.current) {
        setError(typeof err === "string" ? err : String(err));
        setDownloading(false);
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
      setInfo(null);
      setError(null);
    }
    // 隐藏窗口（保留窗口以复用），下次有更新时由 Rust 端重新 show
    getCurrentWebviewWindow().hide().catch(console.error);
  };

  if (!info) return null;

  return (
    <div className="update-prompt">
      <div className="update-prompt-header">
        <Icon name="Rocket" size={16} />
        <span>发现新版本</span>
      </div>
      <div className="update-prompt-version">Levitaire v{info.version}</div>
      {info.notes && <div className="update-prompt-notes">{info.notes}</div>}

      {downloading ? (
        <div className="update-prompt-progress">
          <div className="update-prompt-progress-track">
            <div
              className="update-prompt-progress-fill"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
          <span className="update-prompt-hint">
            {progress != null ? `下载中 ${progress}%` : "下载中…"}
          </span>
        </div>
      ) : (
        <div className="update-prompt-actions">
          <button className="update-prompt-btn update-prompt-btn-primary" onClick={handleInstall}>
            <Icon name="Download" size={14} /> 更新
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
