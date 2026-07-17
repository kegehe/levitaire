import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import "./RecordingTool.css";

function RecordingControls() {
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [recordingActive, setRecordingActive] = useState(false);
  const actionPending = useRef(false);
  // 标记窗口是否已被主动隐藏（stop/cancel/编码完成），
  // 防止残留的 frame 事件将 recordingActive 设回 true 导致窗口重新显示
  const hiddenRef = useRef(false);

  const hideWindow = useCallback(() => {
    hiddenRef.current = true;
    setRecordingActive(false);
    win.hide().catch(() => {});
  }, [win]);

  const syncState = useCallback(() => {
    invoke<{ running: boolean; paused: boolean; elapsedMs: number; frameCount: number }>("get_recording_state")
      .then((state) => {
        setRecordingActive(state.running);
        setPaused(state.paused);
        setElapsedMs(state.elapsedMs);
        setFrameCount(state.frameCount);
        // 录制已停止（非暂停）时，自动隐藏控制窗口
        if (!state.running && !state.paused) {
          hideWindow();
        }
      })
      .catch(() => {});
  }, [hideWindow]);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";

    // Signal that React has rendered before the native window is shown.
    void emit("recording-controls-ready");
    syncState();

    const unlisten = Promise.all([
      listen("recording-progress", (event) => {
        const data = event.payload as { type: string; elapsedMs?: number; frameCount?: number };
        if (data.elapsedMs !== undefined) setElapsedMs(data.elapsedMs);
        if (data.frameCount !== undefined) setFrameCount(data.frameCount);
        if (data.type === "frame") {
          // 窗口已被主动隐藏后，忽略残留的 frame 事件
          if (!hiddenRef.current) {
            setRecordingActive(true);
          }
        }
        if (data.type === "encoding" || data.type === "done" || data.type === "error") {
          hideWindow();
        }
      }),
      listen("recording-controls-started", () => {
        hiddenRef.current = false;
        setRecordingActive(true);
        syncState();
      }),
      listen("recording-controls-finished", () => {
        hideWindow();
      }),
      listen("recording-paused", () => setPaused(true)),
      listen("recording-resumed", () => setPaused(false)),
    ]);
    return () => {
      unlisten.then((handlers) => handlers.forEach((handler) => handler()));
    };
  }, [syncState, hideWindow]);

  useEffect(() => {
    if (!recordingActive) return;
    const timer = window.setInterval(syncState, 200);
    return () => window.clearInterval(timer);
  }, [recordingActive, syncState]);

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  };

  const togglePause = async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke(paused ? "resume_recording" : "pause_recording");
    } catch (error) {
      console.error("recording pause toggle failed:", error);
    } finally {
      actionPending.current = false;
    }
  };

  const stop = async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke("stop_recording");
    } catch (error) {
      console.error("stop_recording failed:", error);
    } finally {
      actionPending.current = false;
    }
  };

  const cancel = async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke("cancel_recording_and_select");
    } catch (error) {
      console.error("cancel_recording failed:", error);
    } finally {
      actionPending.current = false;
    }
  };

  return (
    <div className="rec-rec-controls rec-controls-window">
      <div className="rec-rec-info">
        <span className={`rec-rec-indicator ${paused ? "paused" : "recording"}`} />
        <span className="rec-rec-timer">{formatTime(elapsedMs)}</span>
      </div>
      <div className="rec-rec-frames">{frameCount} 帧</div>
      <div className="rec-rec-buttons">
        <button className={`rec-rec-btn ${paused ? "rec-rec-btn-resume" : "rec-rec-btn-pause"}`} onClick={togglePause} title={paused ? "继续录制" : "暂停录制"}>
          <Icon name={paused ? "Play" : "Pause"} size={14} />
        </button>
        <button className="rec-rec-btn rec-rec-btn-stop" onClick={stop} title="停止录制">
          <Icon name="Square" size={12} />
        </button>
        <button className="rec-rec-btn rec-rec-btn-cancel" onClick={cancel} title="取消录制">
          <Icon name="X" size={14} />
        </button>
      </div>
    </div>
  );
}

export default RecordingControls;
