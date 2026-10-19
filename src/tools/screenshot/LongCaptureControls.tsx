import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../../components/Icon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import "./LongCaptureControls.css";

type CaptureStatus = {
  resultId: number;
  width: number;
  height: number;
  frameCount: number;
  status: "capturing" | "partial" | "completed";
  message?: string | null;
};

type View = { kind: "capturing"; result: CaptureStatus } | { kind: "preview"; result: CaptureStatus; preview: string };

function LongCaptureControls() {
  // ⚠️ 必须 memo 化：getCurrentWebviewWindow() 每次返回**新对象**。capturing 阶段
  // 每 350ms 轮询一次状态（setView 新对象）→ 渲染 → win 变化 → 依赖 [win] 的监听
  // （含 long-capture-completed）反复重建，存在丢事件导致控制条卡在「正在截长图」的窗口。
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [view, setView] = useState<View | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const viewRef = useRef<View | null>(null);
  const actionPending = useRef(false);
  // Invalidates preview loads that finish after the capture was cancelled,
  // closed, or replaced by a newer capture session.
  const previewRequestRef = useRef(0);
  viewRef.current = view;

  // 主题接入：长截图控制条/预览是常驻窗口，必须在挂载时着色并订阅广播，
  // 否则主题在窗口创建之后被修改时不会刷新，且样式会一直停在首次加载的取值上。
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
  }, []);

  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn());
    };
  }, []);

  const showPreview = useCallback(async (result: CaptureStatus) => {
    const requestId = ++previewRequestRef.current;
    try {
      const preview = await invoke<string>("get_long_capture_preview", { resultId: result.resultId });
      if (requestId !== previewRequestRef.current) return;
      setZoom(1);
      setView({ kind: "preview", result, preview: `data:image/png;base64,${preview}` });
      if (requestId !== previewRequestRef.current) return;
      await win.setSize(new LogicalSize(760, 560));
      await win.center();
    } catch (error) {
      console.error("long capture preview failed", error);
    }
  }, [win]);

  useEffect(() => {
    const unlisten = listen<CaptureStatus>("long-capture-started", ({ payload }) => {
      console.info("[long-capture] started", payload);
      previewRequestRef.current++;
      setWarning(null);
      setView({ kind: "capturing", result: payload });
    });
    const unlistenWarning = listen<{ resultId: number; message: string }>("long-capture-warning", ({ payload }) => {
      const current = viewRef.current;
      if (current?.kind === "capturing" && current.result.resultId === payload.resultId) {
        setWarning(payload.message);
      }
    });
    const unlistenDone = listen<CaptureStatus>("long-capture-completed", ({ payload }) => {
      void showPreview(payload);
    });
    const unlistenCancel = listen("long-capture-cancelled", () => {
      previewRequestRef.current++;
      setWarning(null);
      void win.hide();
    });
    const unReadyRequest = listen("long-capture-controls-ready-request", () => {
      void emit("long-capture-controls-ready");
    });
    void emit("long-capture-controls-ready");
    console.info("[long-capture] controls ready");
    return () => {
      unlisten.then((fn) => fn());
      unlistenDone.then((fn) => fn());
      unlistenWarning.then((fn) => fn());
      unlistenCancel.then((fn) => fn());
      unReadyRequest.then((fn) => fn());
    };
  }, [showPreview, win]);

  useEffect(() => {
    const unlisten = win.onCloseRequested((event) => {
      // A native close would otherwise destroy the only controls for an active
      // session, leaving the global screenshot hook and worker running.
      event.preventDefault();
      const current = viewRef.current;
      if (!current || actionPending.current) return;

      actionPending.current = true;
      previewRequestRef.current++;
      const command = current.kind === "capturing" ? "cancel_long_capture" : "discard_long_capture";
      void invoke(command, { resultId: current.result.resultId })
        .catch((error) => console.error("close long capture failed", error))
        .finally(() => {
          actionPending.current = false;
          setView(null);
          void win.hide();
        });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [win]);

  useEffect(() => {
    if (!view || view.kind !== "capturing") return;
    const timer = window.setInterval(() => {
      invoke<CaptureStatus>("get_long_capture_status", { resultId: view.result.resultId })
        .then((result) => setView((current) => current?.kind === "capturing" ? { ...current, result } : current))
        .catch(() => {});
    }, 350);
    return () => window.clearInterval(timer);
  }, [view]);

  const stop = async () => {
    if (!view || view.kind !== "capturing" || actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke<CaptureStatus>("stop_long_capture", { resultId: view.result.resultId });
    } catch (error) {
      console.error("stop long capture failed", error);
    } finally {
      actionPending.current = false;
    }
  };

  const cancel = async () => {
    if (!view || actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke("cancel_long_capture", { resultId: view.result.resultId });
    } catch (error) {
      console.error("cancel long capture failed", error);
    } finally {
      actionPending.current = false;
    }
  };

  const save = async () => {
    if (!view || view.kind !== "preview" || actionPending.current) return;
    actionPending.current = true;
    try {
      const saved = await invoke<boolean>("save_long_capture", { resultId: view.result.resultId });
      // The native save dialog returns false when the user cancels. Keep the
      // preview open in that case so the capture is still available.
      if (saved) {
        await close();
      }
    } catch (error) {
      console.error("save long capture failed", error);
    } finally {
      actionPending.current = false;
    }
  };

  const copy = async () => {
    if (!view || view.kind !== "preview" || actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke("clipboard_set_long_capture", { resultId: view.result.resultId });
    } catch (error) {
      console.error("copy long capture failed", error);
    } finally {
      actionPending.current = false;
    }
  };

  const changeZoom = (delta: number) => {
    setZoom((current) => Math.min(3, Math.max(0.5, Math.round((current + delta) * 100) / 100)));
  };

  const resetZoom = () => setZoom(1);

  const startPreviewDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    void win.startDragging().catch((error) => console.error("Failed to drag long capture preview:", error));
  };

  const close = async () => {
    if (!view) return;
    previewRequestRef.current++;
    await invoke("discard_long_capture", { resultId: view.result.resultId }).catch(() => {});
    await win.hide();
    setView(null);
    setWarning(null);
  };

  if (!view) return null;
  const result = view.result;
  if (view.kind === "capturing") {
    return (
      <div className="long-capture-controls" role="toolbar" aria-label="长截图控制">
        <span className="long-capture-dot" />
        <span className="long-capture-count" title={result.message ?? undefined}>
          <strong>正在截长图</strong>
          <span className="long-capture-instruction">滚动页面后点击完成</span>
        <span className="long-capture-progress">
          {result.status === "partial" ? "部分结果 · " : ""}
          {result.frameCount} 帧 · {result.height}px
          </span>
        {warning && <span className="long-capture-warning">{warning}</span>}
        </span>
        <button className="long-capture-action" onClick={stop} title="完成长截图" aria-label="完成长截图">
          <Icon name="Check" size={15} />
          <span>完成</span>
        </button>
        <button className="long-capture-action" onClick={cancel} title="取消长截图" aria-label="取消长截图">
          <Icon name="X" size={15} />
          <span>取消</span>
        </button>
      </div>
    );
  }
  return (
    <div className="long-capture-preview" role="dialog" aria-label="长截图预览">
      <div className="long-capture-preview-header" onMouseDown={startPreviewDrag}>
        <span className="long-capture-preview-title">{result.width} × {result.height}</span>
        <div className="long-capture-zoom-actions" aria-label="缩放控制">
          <button
            onClick={() => changeZoom(-0.25)}
            title="缩小"
            aria-label="缩小"
            disabled={zoom <= 0.5}
          >
            <Icon name="ZoomOut" size={15} />
          </button>
          <span className="long-capture-zoom-value" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => changeZoom(0.25)}
            title="放大"
            aria-label="放大"
            disabled={zoom >= 3}
          >
            <Icon name="ZoomIn" size={15} />
          </button>
          <button onClick={resetZoom} title="重置缩放" aria-label="重置缩放" disabled={zoom === 1}>
            <Icon name="RotateCcw" size={15} />
          </button>
        </div>
        <button onClick={close} title="关闭" aria-label="关闭"><Icon name="X" size={16} /></button>
      </div>
      <div className="long-capture-image-wrap">
        <img
          src={view.preview}
          alt="长截图预览"
          style={{
            width: `${Math.max(1, Math.round(result.width * zoom))}px`,
            maxWidth: "none",
          }}
        />
      </div>
      {result.message && <p className="long-capture-message">{result.message}</p>}
      <div className="long-capture-actions">
        <button onClick={copy} title="复制图片" aria-label="复制图片"><Icon name="Copy" size={15} /></button>
        <button onClick={save} title="保存图片" aria-label="保存图片"><Icon name="Download" size={15} /></button>
      </div>
    </div>
  );
}

export default LongCaptureControls;
