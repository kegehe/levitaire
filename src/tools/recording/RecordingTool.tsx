import { useState, useCallback, useRef, useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Icon from "../../components/Icon";
import ModeSelector from "./ModeSelector";
import AreaSelector from "./AreaSelector";
import type {
  RecordMode,
  RecordingPhase,
  RecordRegion,
} from "./recordingConfig";
import {
  DEFAULT_GIF_FPS,
  DEFAULT_VIDEO_FPS,
  DEFAULT_MAX_DURATION,
} from "./recordingConfig";
import "../screenshot/ScreenshotTool.css";
import "./RecordingTool.css";
import { ensureRecordingControlsWindow } from "../../utils/toolWindows";

const CONTROLS_WIDTH = 136;
const CONTROLS_HEIGHT = 128;
const CONTROLS_GAP = 8;

interface ControlPosition {
  left: number;
  top: number;
}

interface CssRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A full-screen region has no outside space in which to render an outline. */
export function isEdgeToEdgeRegion(
  region: CssRegion,
  viewportWidth: number,
  viewportHeight: number,
) {
  const tolerance = 1;
  return region.left <= tolerance
    && region.top <= tolerance
    && region.left + region.width >= viewportWidth - tolerance
    && region.top + region.height >= viewportHeight - tolerance;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Prefers unused space around the region, then falls back to a visible floating position. */
export function getControlsPosition(
  region: CssRegion,
  viewportWidth: number,
  viewportHeight: number,
): ControlPosition | null {
  const maxLeft = viewportWidth - CONTROLS_WIDTH - CONTROLS_GAP;
  const maxTop = viewportHeight - CONTROLS_HEIGHT - CONTROLS_GAP;
  if (maxLeft < CONTROLS_GAP || maxTop < CONTROLS_GAP) return null;

  const right = region.left + region.width + CONTROLS_GAP;
  if (right <= maxLeft) return { left: right, top: clamp(region.top, CONTROLS_GAP, maxTop) };

  const left = region.left - CONTROLS_GAP - CONTROLS_WIDTH;
  if (left >= CONTROLS_GAP) return { left, top: clamp(region.top, CONTROLS_GAP, maxTop) };

  const bottom = region.top + region.height + CONTROLS_GAP;
  if (bottom <= maxTop) return { left: clamp(region.left, CONTROLS_GAP, maxLeft), top: bottom };

  const top = region.top - CONTROLS_GAP - CONTROLS_HEIGHT;
  if (top >= CONTROLS_GAP) return { left: clamp(region.left, CONTROLS_GAP, maxLeft), top };

  return { left: maxLeft, top: CONTROLS_GAP };
}

function RecordingTool() {
  const win = getCurrentWebviewWindow();
  const [phase, setPhase] = useState<RecordingPhase>("mode_select");
  const [mode, setMode] = useState<RecordMode | null>(null);
  const [region, setRegion] = useState<RecordRegion | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 预览数据
  const [gifBase64, setGifBase64] = useState<string | null>(null);
  const [videoBase64, setVideoBase64] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [resultWidth, setResultWidth] = useState(0);
  const [resultHeight, setResultHeight] = useState(0);
  const scaleRef = useRef<number>(1);
  // DPI 缩放和虚拟桌面原点（用于物理像素 ↔ CSS 像素转换）
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // 代际计数
  const genRef = useRef(0);
  const cancellingRef = useRef(false);
  // phase ref 用于异步回调中读取最新 phase
  const phaseRef = useRef<RecordingPhase>("mode_select");
  phaseRef.current = phase;

  const cancelRecording = useCallback(async () => {
    genRef.current++;
    cancellingRef.current = true;
    const shouldCancelBackend = phaseRef.current !== "mode_select";
    setPhase("mode_select");
    setMode(null);
    setRegion(null);
    setElapsedMs(0);
    setFrameCount(0);
    setError(null);
    setGifBase64(null);
    setVideoBase64(null);
    setVideoPath(null);
    if (shouldCancelBackend) {
      await invoke("cancel_recording").catch(console.error);
    }
    // 退出录制模式：隐藏 overlay，恢复截图模式
    await invoke("cancel_recording_select").catch(console.error);
  }, []);

  const stopRecording = useCallback(async () => {
    if (phaseRef.current !== "recording" && phaseRef.current !== "paused") return;
    try {
      await invoke("stop_recording");
      setPhase("encoding");
    } catch (err) {
      console.error("stop_recording failed:", err);
      setError(typeof err === "string" ? err : String(err));
      setPhase("error");
    }
  }, []);

  // 透明背景
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  // 获取 DPI 缩放和虚拟桌面原点
  useEffect(() => {
    invoke<{ originX: number; originY: number; width: number; height: number }>("get_virtual_desktop_bounds")
      .then((b) => { originRef.current = { x: b.originX, y: b.originY }; })
      .catch(() => {});
  }, [win]);

  // 监听录制进度事件
  useEffect(() => {
    const un = listen("recording-progress", (event) => {
      const data = event.payload as {
        type: string;
        frameCount?: number;
        elapsedMs?: number;
          message?: string;
          gifBase64?: string;
          videoBase64?: string;
          videoPath?: string;
          width?: number;
        height?: number;
        sizeBytes?: number;
      };
      if (cancellingRef.current) return;
      switch (data.type) {
        case "frame":
          if (data.frameCount !== undefined) setFrameCount(data.frameCount);
          if (data.elapsedMs !== undefined) setElapsedMs(data.elapsedMs);
          break;
        case "encoding":
          void invoke("finish_recording_controls").catch(console.error);
          setPhase("encoding");
          break;
        case "done":
          void invoke("finish_recording_controls").catch(console.error);
          if (data.gifBase64) {
            setGifBase64(data.gifBase64);
          }
          if (data.videoBase64) {
            setVideoBase64(data.videoBase64);
          }
          if (data.videoPath) {
            setVideoPath(data.videoPath);
          }
          if (data.width) setResultWidth(data.width);
          if (data.height) setResultHeight(data.height);
          if (data.elapsedMs !== undefined) setElapsedMs(data.elapsedMs);
          if (data.frameCount !== undefined) setFrameCount(data.frameCount);
          setPhase("preview");
          break;
        case "error":
          void invoke("finish_recording_controls").catch(console.error);
          setError(data.message ?? "录制错误");
          setPhase("error");
          break;
      }
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && phaseRef.current === "encoding") {
        event.preventDefault();
        cancelRecording();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelRecording]);

  useEffect(() => {
    if (phase !== "encoding") return;
    const timer = window.setTimeout(() => {
      if (phaseRef.current !== "encoding") return;
      cancellingRef.current = true;
      setError("视频编码超时，请取消后重试");
      invoke("cancel_recording").catch(console.error);
      setPhase("error");
    }, 45_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // 监听 Esc 取消录制
  useEffect(() => {
    const un = listen("recording-esc-cancel", () => {
      cancelRecording();
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 监听热键触发
  useEffect(() => {
    const un = listen("recording-hotkey-triggered", () => {
      const currentPhase = phaseRef.current;
      if (currentPhase === "recording" || currentPhase === "paused") {
        stopRecording();
      }
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [stopRecording]);

  useEffect(() => {
    const unlisten = Promise.all([
      listen("recording-stop-requested", () => setPhase("encoding")),
      listen("recording-paused", () => setPhase("paused")),
      listen("recording-resumed", () => setPhase("recording")),
    ]);
    return () => {
      unlisten.then((handlers) => handlers.forEach((handler) => handler()));
    };
  }, []);

  // 录制中计时器
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const timer = setInterval(() => {
      invoke<{ elapsedMs: number }>("get_recording_state").then((s) => {
        setElapsedMs(s.elapsedMs);
      }).catch(() => {});
    }, 200);
    return () => clearInterval(timer);
  }, [phase]);

  const startRecording = useCallback(async (selectedMode: RecordMode) => {
    cancellingRef.current = false;
    setMode(selectedMode);
    setPhase("area_select");
  }, []);

  const handleAreaSelected = useCallback(async (selectedRegion: RecordRegion) => {
    if (!mode) return;

    const fps = mode === "gif" ? DEFAULT_GIF_FPS : DEFAULT_VIDEO_FPS;
    const maxDurationSec = DEFAULT_MAX_DURATION;
    let recordingStarted = false;

    try {
      // Refresh these values at the point of use. The selection UI can be used
      // before this component's initial DPI query has completed.
      const bounds = await invoke<{ originX: number; originY: number; width: number }>("get_virtual_desktop_bounds");
      const origin = { x: bounds.originX, y: bounds.originY };
      const scale = bounds.width / window.innerWidth;
      scaleRef.current = scale;
      originRef.current = origin;
      setRegion(selectedRegion);
      const controlsPosition = getControlsPosition(
        {
          left: (selectedRegion.left - origin.x) / scale,
          top: (selectedRegion.top - origin.y) / scale,
          width: selectedRegion.width / scale,
          height: selectedRegion.height / scale,
        },
        window.innerWidth,
        window.innerHeight,
      );
      if (!controlsPosition) throw new Error("屏幕空间不足，无法显示录制控制栏");

      await invoke("start_recording", {
        left: selectedRegion.left,
        top: selectedRegion.top,
        width: selectedRegion.width,
        height: selectedRegion.height,
        mode,
        fps,
        maxDurationSec,
      });
      recordingStarted = true;
      const controls = await ensureRecordingControlsWindow();
      await controls.setPosition(new PhysicalPosition(
        Math.round(origin.x + controlsPosition.left * scale),
        Math.round(origin.y + controlsPosition.top * scale),
      ));
      await controls.show();
      await invoke("show_recording_controls");
      setPhase("recording");
      // overlay 保持显示，展示选区框 + 录制控制面板
    } catch (err) {
      if (recordingStarted) {
        await invoke("cancel_recording").catch(console.error);
      }
      console.error("start_recording failed:", err);
      setError(typeof err === "string" ? err : String(err));
      setPhase("error");
    }
  }, [mode, win]);

  const copyToClipboard = useCallback(async () => {
    if (mode === "gif" && gifBase64) {
      try {
        await invoke("clipboard_set_gif", {
          base64Data: `data:image/gif;base64,${gifBase64}`,
        });
      } catch (err) {
        console.error("clipboard_set_gif failed:", err);
      }
    } else if (mode === "video" && videoBase64) {
      try {
        await invoke("clipboard_set_image", {
          base64Data: `data:video/mp4;base64,${videoBase64}`,
        });
      } catch (err) {
        console.error("clipboard_set_image failed:", err);
      }
    }
  }, [mode, gifBase64, videoBase64]);

  const saveFile = useCallback(async () => {
    if (mode === "gif" && gifBase64) {
      try {
        await invoke("save_gif", {
          base64Data: `data:image/gif;base64,${gifBase64}`,
          filename: "recording.gif",
        });
      } catch (err) {
        console.error("save_gif failed:", err);
      }
    } else if (mode === "video" && videoPath) {
      try {
        await invoke("save_video_file", {
          sourcePath: videoPath,
          filename: "recording.mp4",
        });
      } catch (err) {
        console.error("save_video_file failed:", err);
      }
    } else if (mode === "video" && videoBase64) {
      try {
        await invoke("save_video", {
          base64Data: `data:video/mp4;base64,${videoBase64}`,
          filename: "recording.mp4",
        });
      } catch (err) {
        console.error("save_video failed:", err);
      }
    }
  }, [mode, gifBase64, videoBase64, videoPath]);

  const closePreview = useCallback(() => {
    cancelRecording();
  }, [cancelRecording]);

  const restartRecording = useCallback(async () => {
    genRef.current++;
    cancellingRef.current = true;
    try {
      // Discard the previous result but keep the overlay session open.
      await invoke("cancel_recording");
      setRegion(null);
      setElapsedMs(0);
      setFrameCount(0);
      setError(null);
      setGifBase64(null);
      setVideoBase64(null);
      setVideoPath(null);
      setResultWidth(0);
      setResultHeight(0);
      // Keep the current GIF/video choice and go straight to area selection.
      setPhase(mode ? "area_select" : "mode_select");
      await invoke("start_recording_select");
    } catch (err) {
      console.error("restart recording failed:", err);
      setError(typeof err === "string" ? err : String(err));
      setPhase("error");
    } finally {
      cancellingRef.current = false;
    }
  }, [mode]);

  // 格式化时间 mm:ss
  const formatTime = (ms: number) => {
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="rec-overlay">
      {/* 模式选择 */}
      {phase === "mode_select" && (
        <ModeSelector
          onSelect={startRecording}
          onCancel={cancelRecording}
        />
      )}

      {/* 区域选择 */}
      {phase === "area_select" && (
        <AreaSelector
          onAreaSelected={handleAreaSelected}
          onCancel={cancelRecording}
        />
      )}

      {/* 录制中 / 暂停中：选区框 + 控制面板 */}
      {(phase === "recording" || phase === "paused") && region && (() => {
        const origin = originRef.current;
        const scale = scaleRef.current;
        // 物理像素 → CSS 像素（overlay 坐标空间）
        const cssLeft = (region.left - origin.x) / scale;
        const cssTop = (region.top - origin.y) / scale;
        const cssWidth = region.width / scale;
        const cssHeight = region.height / scale;
        const isFullscreen = isEdgeToEdgeRegion(
          { left: cssLeft, top: cssTop, width: cssWidth, height: cssHeight },
          window.innerWidth,
          window.innerHeight,
        );
        return (
          <>
            {/* 半透明遮罩：选区外四个方向 */}
            <div className="rec-rec-mask" style={{ left: 0, top: 0, width: "100%", height: `${cssTop}px` }} />
            <div className="rec-rec-mask" style={{ left: 0, top: cssTop + cssHeight, width: "100%", bottom: 0 }} />
            <div className="rec-rec-mask" style={{ left: 0, top: cssTop, width: `${cssLeft}px`, height: cssHeight }} />
            <div className="rec-rec-mask" style={{ left: cssLeft + cssWidth, top: cssTop, right: 0, height: cssHeight }} />

            {/* 选区框：录制期间用 outline（向外延伸到遮罩区域）代替 border（向内画在录制区域内），
                outline 不占布局空间且在录制区域外，BitBlt 不会截到 */}
            <div
              className={`rec-rec-selection${isFullscreen ? " rec-rec-selection-fullscreen" : " rec-rec-selection-outline"}`}
              style={{
                left: cssLeft,
                top: cssTop,
                width: cssWidth,
                height: cssHeight,
                border: "none",
                outline: isFullscreen ? "none" : undefined,
              }}
            >
              {/* 尺寸标签 */}
              <div className="rec-rec-size-badge">
                {region.width} × {region.height}
              </div>
            </div>

          </>
        );
      })()}

      {/* 编码中 */}
      {phase === "encoding" && (
        <div className="rec-encoding-panel">
          <Icon name="Loader2" size={24} className="rec-spin" />
          <span>正在编码{mode === "gif" ? " GIF" : "视频"}…</span>
          <button className="rec-encoding-cancel" onClick={cancelRecording} title="取消编码">
            <Icon name="X" size={14} />
          </button>
        </div>
      )}

      {/* 预览 */}
      {phase === "preview" && (
        <div className="rec-preview-panel">
          <div className="rec-preview-header">
            <span>录制完成</span>
            <button className="rec-preview-close" onClick={closePreview}>
              <Icon name="X" size={16} />
            </button>
          </div>
          <div className="rec-preview-content">
            {mode === "gif" && gifBase64 && (
              <img
                src={`data:image/gif;base64,${gifBase64}`}
                alt="GIF 预览"
                className="rec-preview-gif"
              />
            )}
            {mode === "video" && videoPath && (
              <video
                src={convertFileSrc(videoPath)}
                controls
                className="rec-preview-video"
              />
            )}
            {mode === "video" && !videoPath && videoBase64 && (
              <video
                src={`data:video/mp4;base64,${videoBase64}`}
                controls
                className="rec-preview-video"
              />
            )}
          </div>
          <div className="rec-preview-info">
            {resultWidth}×{resultHeight} · {frameCount} 帧 · {formatTime(elapsedMs)}
          </div>
          <div className="rec-preview-actions">
            {mode === "gif" && (
              <button className="rec-action-btn" onClick={copyToClipboard}>
                <Icon name="Copy" size={14} /> 复制
              </button>
            )}
            <button className="rec-action-btn rec-action-primary" onClick={saveFile}>
              <Icon name="Download" size={14} /> 保存
            </button>
            <button className="rec-action-btn" onClick={restartRecording}>
              重新录制
            </button>
          </div>
        </div>
      )}

      {/* 错误 */}
      {phase === "error" && (
        <div className="rec-error-panel">
          <Icon name="AlertCircle" size={24} />
          <span>{error ?? "未知错误"}</span>
          <button onClick={cancelRecording}>关闭</button>
        </div>
      )}
    </div>
  );
}

export default RecordingTool;
