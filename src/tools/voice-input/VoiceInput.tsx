import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import { fetchSttConfig } from "../../constants/sttConfig";
import "./VoiceInput.css";

/** 录音浮层状态 */
type Phase =
  | "starting" // 初始化麦克风
  | "recording" // 录音中
  | "transcribing" // 识别中
  | "done" // 完成（显示文本预览）
  | "error"; // 错误

interface SttStatusEvent {
  phase: string;
  message?: string;
}

/** 单次录音最长 60 秒 */
const MAX_RECORD_MS = 60_000;

/** Uint8Array → base64，分块拼接避免 fromCharCode 栈溢出 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

function VoiceInput() {
  const [phase, setPhase] = useState<Phase>("starting");
  const [message, setMessage] = useState("");
  const [resultText, setResultText] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const autoPasteRef = useRef(true);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppingRef = useRef(false);

  // 同步主题 + 透明背景（独立窗口）
  useEffect(() => {
    const theme = localStorage.getItem("floatory-theme") || "light";
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) {
      root.style.background = "transparent";
      root.style.margin = "0";
      root.style.height = "100%";
    }
  }, []);

  // 监听后端 stt-status 事件（识别中/错误）
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let cancelled = false;
    listen<SttStatusEvent>("stt-status", (e) => {
      const p = e.payload;
      if (p.phase === "transcribing") {
        setPhase("transcribing");
      } else if (p.phase === "error") {
        setPhase("error");
        setMessage(p.message ?? "识别失败");
      }
    }).then((fn) => {
      // 若组件在 listen resolve 前已卸载，立即取消刚拿到的监听器，避免泄漏
      if (cancelled) {
        fn();
      } else {
        un = fn;
      }
    });
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);

  // 清理录音资源
  const cleanupAudio = useCallback(() => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  // 停止录音 → 识别 → 粘贴
  const stopAndTranscribe = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;

    const recorder = recorderRef.current;
    const chunks = chunksRef.current;
    chunksRef.current = [];

    if (!recorder || recorder.state === "inactive") {
      cleanupAudio();
      stoppingRef.current = false;
      invoke("hide_voice_window").catch(() => {});
      return;
    }

    // 用 onstop 收集完整 Blob 后再识别
    recorder.onstop = async () => {
      cleanupAudio();
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (blob.size === 0) {
        stoppingRef.current = false;
        invoke("hide_voice_window").catch(() => {});
        return;
      }
      try {
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const mime = blob.type || "audio/webm";
        setPhase("transcribing");
        const text = await invoke<string>("stt_transcribe", {
          audio: bytesToBase64(bytes),
          mime,
        });
        if (!text.trim()) {
          setPhase("error");
          setMessage("识别结果为空");
          hideTimerRef.current = setTimeout(() => {
            invoke("hide_voice_window").catch(() => {});
          }, 2000);
          return;
        }
        setResultText(text);
        setPhase("done");
        if (autoPasteRef.current) {
          await invoke("stt_paste_text", { text }).catch((err) => {
            setPhase("error");
            setMessage(String(err));
          });
        }
        hideTimerRef.current = setTimeout(() => {
          invoke("hide_voice_window").catch(() => {});
        }, 2000);
      } catch (err) {
        setPhase("error");
        setMessage(String(err));
        hideTimerRef.current = setTimeout(() => {
          invoke("hide_voice_window").catch(() => {});
        }, 3000);
      } finally {
        stoppingRef.current = false;
      }
    };

    try {
      recorder.stop();
    } catch {
      cleanupAudio();
      stoppingRef.current = false;
    }
  }, [cleanupAudio]);

  // 启动录音
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // MediaRecorder 产出 webm/opus，云端可直接解码，无需重采样
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      recorder.start();
      setPhase("recording");

      // 60 秒自动停止
      autoTimerRef.current = setTimeout(() => {
        stopAndTranscribe();
      }, MAX_RECORD_MS);
    } catch (err) {
      setPhase("error");
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setMessage("无法访问麦克风，请在 Windows 麦克风设置中允许应用访问");
      } else {
        setMessage(`麦克风初始化失败: ${String(err)}`);
      }
    }
  }, [stopAndTranscribe]);

  // 挂载即开始录音
  useEffect(() => {
    fetchSttConfig().then((cfg) => {
      autoPasteRef.current = cfg.autoPaste;
    });
    startRecording();
    return () => {
      cleanupAudio();
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [startRecording, cleanupAudio]);

  // Esc 取消（录音中）或关闭（其他态）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (phase === "recording") {
          stoppingRef.current = true;
          chunksRef.current = [];
          cleanupAudio();
          invoke("hide_voice_window").catch(() => {});
        } else if (phase === "transcribing") {
          // hide_voice_window cancels the active request before destroying this window.
          invoke("hide_voice_window").catch(() => {});
        } else if (phase === "done" || phase === "error") {
          invoke("hide_voice_window").catch(() => {});
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, cleanupAudio]);

  // 失焦关闭（仅在录音态/完成态/错误态，避免识别中误关）
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const unFocus = win.onFocusChanged(({ payload: focused }) => {
      if (!focused && (phase === "recording" || phase === "done" || phase === "error")) {
        if (phase === "recording") {
          stoppingRef.current = true;
          chunksRef.current = [];
          cleanupAudio();
        }
        invoke("hide_voice_window").catch(() => {});
      }
    });
    return () => {
      unFocus.then((fn) => fn());
    };
  }, [phase, cleanupAudio]);

  const handleStopClick = () => {
    if (phase === "recording") {
      stopAndTranscribe();
    } else {
      invoke("hide_voice_window").catch(() => {});
    }
  };

  return (
    <div className="voice-container">
      <div className={`voice-body phase-${phase}`}>
        {phase === "starting" && (
          <>
            <Icon name="Mic" size={24} />
            <span>准备麦克风…</span>
          </>
        )}
        {phase === "recording" && (
          <>
            <Icon name="Mic" size={24} className="voice-pulse" />
            <span>录音中…</span>
            <button className="voice-stop" onClick={handleStopClick}>
              停止
            </button>
          </>
        )}
        {phase === "transcribing" && (
          <>
            <Icon name="Loader2" size={22} className="voice-spin" />
            <span>识别中…</span>
          </>
        )}
        {phase === "done" && (
          <>
            <Icon name="Check" size={22} />
            <span className="voice-result">{resultText}</span>
          </>
        )}
        {phase === "error" && (
          <>
            <Icon name="AlertCircle" size={22} />
            <span className="voice-error">{message}</span>
            <button className="voice-stop" onClick={handleStopClick}>
              关闭
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default VoiceInput;
