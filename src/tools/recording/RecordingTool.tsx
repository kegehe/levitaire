import { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Icon from "../../components/Icon";
import ModeSelector from "./ModeSelector";
import AreaSelector from "./AreaSelector";
import type { RecordMode, RecordingPhase, RecordRegion } from "./recordingConfig";
import { fetchRecordingConfig } from "./recordingConfig";
import "../screenshot/ScreenshotTool.css";
import "./RecordingTool.css";
import { ensureRecordingControlsWindow } from "../../utils/toolWindows";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";

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
  return (
    region.left <= tolerance &&
    region.top <= tolerance &&
    region.left + region.width >= viewportWidth - tolerance &&
    region.top + region.height >= viewportHeight - tolerance
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Prefers unused space around the region. Returns `null` when the region
 * leaves no outside space large enough for the controls (e.g. a full-screen
 * recording). The caller then falls back to overlay placement for full-screen
 * regions or shrinks a near-full-screen region to make room.
 */
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

  return null;
}

/** 控制栏的最终放置结果 */
export interface ControlsPlacement {
  region: CssRegion;
  controls: ControlPosition;
  /** 控制栏是否覆盖在录制区域内。为 true 表示区域铺满视口（全屏），
   * 控制栏无处可放，调用方必须不显示控制栏（否则会被 BitBlt 截进视频），
   * 直接录制完整区域；为 false 时控制栏在录制区域外，可安全显示。 */
  overlay: boolean;
}

/**
 * Resolves where to place the recording controls. Prefers unused space outside
 * the region; when the region is full-screen (edge-to-edge) there is no outside
 * space, so the controls would have to overlay the recorded area — instead of
 * shrinking the region (which would drop screen content from the video), the
 * caller keeps the full region and simply never shows the control bar.
 * Returns `null` when the viewport cannot fit the controls anywhere (the caller
 * reports an error then).
 */
export function resolveControlsPlacement(
  region: CssRegion,
  viewportWidth: number,
  viewportHeight: number,
): ControlsPlacement | null {
  const outside = getControlsPosition(region, viewportWidth, viewportHeight);
  if (outside) return { region, controls: outside, overlay: false };

  // 全屏（铺满视口）：控制栏在区域外无处可放。不收缩录制区域（否则成片丢失
  // 屏幕边缘内容），而是标记 overlay 让调用方在开始录制前不显示控制栏，从而
  // 录到完整画面。全屏录制根本不显示控制栏，故 controls 位置仅用于类型完整性，
  // 不校验视口能否容纳控制栏（调用方忽略该字段）。
  if (isEdgeToEdgeRegion(region, viewportWidth, viewportHeight)) {
    return { region, controls: { left: CONTROLS_GAP, top: CONTROLS_GAP }, overlay: true };
  }

  // 非全屏区域在区域外放不下控制栏时，才把区域底部收缩为控制栏让位。
  const shrunkHeight = Math.max(
    region.height - (CONTROLS_HEIGHT + CONTROLS_GAP * 2),
    CONTROLS_HEIGHT,
  );
  const controlsTop = region.top + shrunkHeight + CONTROLS_GAP;
  // 控制栏必须完整落在视口内，否则说明屏幕空间确实不足
  if (
    viewportWidth >= CONTROLS_WIDTH + CONTROLS_GAP * 2 &&
    controlsTop + CONTROLS_HEIGHT <= viewportHeight
  ) {
    return {
      region: { ...region, height: shrunkHeight },
      controls: {
        left: clamp(
          Math.round((viewportWidth - CONTROLS_WIDTH) / 2),
          CONTROLS_GAP,
          viewportWidth - CONTROLS_WIDTH - CONTROLS_GAP,
        ),
        top: controlsTop,
      },
      overlay: false,
    };
  }
  return null;
}

function RecordingTool() {
  const win = getCurrentWebviewWindow();
  const [phase, setPhase] = useState<RecordingPhase>("mode_select");
  const [mode, setMode] = useState<RecordMode | null>(null);
  const [region, setRegion] = useState<RecordRegion | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 预览面板内复制/保存等操作的临时错误提示（4 秒后自动清除），
  // 与全局 error（切换到错误面板）区分：操作失败不应丢失预览界面。
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 预览数据
  const [gifBase64, setGifBase64] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [resultWidth, setResultWidth] = useState(0);
  const [resultHeight, setResultHeight] = useState(0);
  const scaleRef = useRef<number>(1);
  // DPI 缩放和虚拟桌面原点（用于物理像素 ↔ CSS 像素转换）
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // 代际计数
  const genRef = useRef(0);
  const cancellingRef = useRef(false);
  // 组件是否仍挂载（异步回调防竞态：用户取消导致组件卸载后跳过后续操作）
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
  }, []);

  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn()).catch(console.error);
    };
  }, []);
  // phase ref 用于异步回调中读取最新 phase
  const phaseRef = useRef<RecordingPhase>("mode_select");
  phaseRef.current = phase;

  // 显示一条临时错误提示（4 秒后自动清除），用于复制/保存等操作失败时
  // 给用户可见反馈而不切换离开预览面板
  const showActionError = useCallback((msg: string) => {
    setActionError(msg);
    if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current);
    actionErrorTimer.current = setTimeout(() => setActionError(null), 4000);
  }, []);

  // 清除操作错误提示及其自动清除计时器
  const clearActionError = useCallback(() => {
    setActionError(null);
    if (actionErrorTimer.current) {
      clearTimeout(actionErrorTimer.current);
      actionErrorTimer.current = null;
    }
  }, []);

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
    clearActionError();
    setGifBase64(null);
    setVideoPath(null);
    if (shouldCancelBackend) {
      await invoke("cancel_recording").catch(console.error);
    }
    // 退出录制模式：隐藏 overlay，恢复截图模式
    await invoke("cancel_recording_select").catch(console.error);
  }, [clearActionError]);

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
    // StrictMode 下 effect 会 double-invoke（mount→unmount→remount），
    // 每次运行都重置 mountedRef，保证真实挂载期间始终为 true。
    mountedRef.current = true;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 组件卸载时清除操作错误提示计时器
  useEffect(() => {
    return () => {
      if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current);
    };
  }, []);

  // 获取 DPI 缩放和虚拟桌面原点
  useEffect(() => {
    invoke<{ originX: number; originY: number; width: number; height: number }>(
      "get_virtual_desktop_bounds",
    )
      .then((b) => {
        originRef.current = { x: b.originX, y: b.originY };
      })
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

  const startRecording = useCallback(async (selectedMode: RecordMode) => {
    cancellingRef.current = false;
    setMode(selectedMode);
    setPhase("area_select");
  }, []);

  const handleAreaSelected = useCallback(
    async (selectedRegion: RecordRegion) => {
      if (!mode) return;
      // 重入防护：双击「开始选择」或并发回调只允许在区域选择阶段触发，
      // 避免第二次调用把正在录制的 UI 切到错误面板。
      if (phaseRef.current !== "area_select") return;

      let recordingStarted = false;

      try {
        // 读取用户在设置中配置的帧率与最长时长（未设置时回退默认值）
        const recordingConfig = await fetchRecordingConfig();
        const fps = mode === "gif" ? recordingConfig.gifFps : recordingConfig.videoFps;
        const maxDurationSec = recordingConfig.maxDurationSec;
        // Refresh these values at the point of use. The selection UI can be used
        // before this component's initial DPI query has completed.
        const bounds = await invoke<{ originX: number; originY: number; width: number }>(
          "get_virtual_desktop_bounds",
        );
        const origin = { x: bounds.originX, y: bounds.originY };
        const scale = bounds.width / window.innerWidth;
        scaleRef.current = scale;
        originRef.current = origin;

        // 物理像素 → CSS 像素（overlay 坐标空间）
        const cssRegion: CssRegion = {
          left: (selectedRegion.left - origin.x) / scale,
          top: (selectedRegion.top - origin.y) / scale,
          width: selectedRegion.width / scale,
          height: selectedRegion.height / scale,
        };

        // 全屏（铺满屏幕）等场景下控制栏在区域外无处可放，resolveControlsPlacement
        // 会对全屏区域返回 overlay 标记（不收缩），其余场景收缩区域底部为控制栏让位。
        const resolved = resolveControlsPlacement(cssRegion, window.innerWidth, window.innerHeight);
        if (!resolved) throw new Error("屏幕空间不足，无法显示录制控制栏");

        // 全屏录制：控制栏无处可放，不显示它（会被 BitBlt 截进视频），也不收缩
        // 录制区域（否则成片丢失屏幕边缘内容）。直接录制完整区域，通过全局快捷键
        // 控制：Ctrl+Shift+S 停止、Ctrl+Shift+P 暂停/继续、Esc 取消。
        if (resolved.overlay) {
          // 同步提交区域与阶段切换：确保 AreaSelector 的全屏面板/顶部标签在
          // start_recording 抓第一帧前已从 DOM 卸载（flushSync 同步提交，
          // 比 setTimeout(0) 更确定；React 18 并发调度下 setTimeout 非契约保证）。
          flushSync(() => {
            setRegion(selectedRegion);
            setPhase("recording");
          });
          // 用户可能已按 Esc/取消（组件卸载或 cancellingRef 置位），此时不应再启动录制。
          if (cancellingRef.current || !mountedRef.current) return;
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
          // start_recording 的 IPC 期间用户仍可能取消（Esc），此时后端已启动录制，
          // 必须停掉，避免后台静默录满整段时长。
          if (cancellingRef.current || !mountedRef.current) {
            await invoke("cancel_recording").catch(console.error);
            return;
          }
          // 遮罩改为点击穿透，避免遮挡被录制应用的交互
          await invoke("show_recording_controls");
          return;
        }

        // 未收缩时直接用原始物理区域，避免 DPI 浮点回算导致 ±1px 偏差；
        // 仅收缩（近似全屏）时才用收缩后的高度换算物理像素。
        const regionToRecord: RecordRegion =
          resolved.region.height === cssRegion.height
            ? selectedRegion
            : {
                ...selectedRegion,
                height: Math.round(resolved.region.height * scale),
              };
        const controlsPosition = resolved.controls;

        setRegion(regionToRecord);

        await invoke("start_recording", {
          left: regionToRecord.left,
          top: regionToRecord.top,
          width: regionToRecord.width,
          height: regionToRecord.height,
          mode,
          fps,
          maxDurationSec,
        });
        recordingStarted = true;
        const controls = await ensureRecordingControlsWindow();
        await controls.setPosition(
          new PhysicalPosition(
            Math.round(origin.x + controlsPosition.left * scale),
            Math.round(origin.y + controlsPosition.top * scale),
          ),
        );
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
    },
    [mode, win],
  );

  // 仅 GIF 模式下界面提供“复制”按钮；视频无复制入口，且 video/mp4 数据
  // 无法作为图片写入剪贴板，故不再保留 video 分支（曾是不可达死代码）。
  const copyToClipboard = useCallback(async () => {
    if (mode === "gif" && gifBase64) {
      clearActionError();
      try {
        await invoke("clipboard_set_gif", {
          base64Data: `data:image/gif;base64,${gifBase64}`,
        });
      } catch (err) {
        console.error("clipboard_set_gif failed:", err);
        // 用户可能在 invoke 期间已关闭预览（cancelRecording 清空了 actionError）
        // 或组件已卸载，此时不再显示错误，避免过期错误残留到下一次录制结果。
        if (phaseRef.current !== "preview" || !mountedRef.current) return;
        showActionError(
          typeof err === "string" ? err : ((err as { message?: string })?.message ?? "复制失败"),
        );
      }
    }
  }, [mode, gifBase64, showActionError, clearActionError]);

  const saveFile = useCallback(async () => {
    const fail = (err: unknown) => {
      console.error("save failed:", err);
      if (phaseRef.current !== "preview" || !mountedRef.current) return;
      showActionError(
        typeof err === "string" ? err : ((err as { message?: string })?.message ?? "保存失败"),
      );
    };
    if (mode === "gif" && gifBase64) {
      clearActionError();
      try {
        await invoke("save_gif", {
          base64Data: `data:image/gif;base64,${gifBase64}`,
          filename: "recording.gif",
        });
      } catch (err) {
        fail(err);
      }
    } else if (mode === "video" && videoPath) {
      clearActionError();
      try {
        await invoke("save_video_file", {
          sourcePath: videoPath,
          filename: "recording.mp4",
        });
      } catch (err) {
        fail(err);
      }
    }
  }, [mode, gifBase64, videoPath, showActionError, clearActionError]);

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
      clearActionError();
      setGifBase64(null);
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
  }, [mode, clearActionError]);

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
        <ModeSelector onSelect={startRecording} onCancel={cancelRecording} />
      )}

      {/* 区域选择 */}
      {phase === "area_select" && (
        <AreaSelector onAreaSelected={handleAreaSelected} onCancel={cancelRecording} />
      )}

      {/* 录制中 / 暂停中：选区框 + 控制面板 */}
      {(phase === "recording" || phase === "paused") &&
        region &&
        (() => {
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
              <div
                className="rec-rec-mask"
                style={{ left: 0, top: 0, width: "100%", height: `${cssTop}px` }}
              />
              <div
                className="rec-rec-mask"
                style={{ left: 0, top: cssTop + cssHeight, width: "100%", bottom: 0 }}
              />
              <div
                className="rec-rec-mask"
                style={{ left: 0, top: cssTop, width: `${cssLeft}px`, height: cssHeight }}
              />
              <div
                className="rec-rec-mask"
                style={{ left: cssLeft + cssWidth, top: cssTop, right: 0, height: cssHeight }}
              />

              {/* 选区框：非全屏录制用 outline（向外延伸到遮罩区域）代替 border（向内画在
                录制区域内），outline 不占布局空间且在录制区域外，BitBlt 不会截到。
                全屏录制没有区域外空间（outline 无处可画），而 inset 边框会画进录制区域
                被 BitBlt 截入视频，因此全屏录制期间不渲染选区框，保证成片干净。 */}
              {!isFullscreen && (
                <div
                  className="rec-rec-selection rec-rec-selection-outline"
                  style={{
                    left: cssLeft,
                    top: cssTop,
                    width: cssWidth,
                    height: cssHeight,
                    border: "none",
                  }}
                >
                  {/* 尺寸标签 */}
                  <div className="rec-rec-size-badge">
                    {region.width} × {region.height}
                  </div>
                </div>
              )}
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
              <video src={convertFileSrc(videoPath)} controls className="rec-preview-video" />
            )}
          </div>
          <div className="rec-preview-info">
            {resultWidth}×{resultHeight} · {frameCount} 帧 · {formatTime(elapsedMs)}
          </div>
          {actionError && (
            <div className="rec-action-error" role="alert">
              {actionError}
            </div>
          )}
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
