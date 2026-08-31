import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Copy, X } from "lucide-react";

import "./PinOcrResult.css";

interface Payload { pinId: number; text?: string; error?: string }

export default function PinOcrResult() {
  const win = getCurrentWebviewWindow();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const show = listen<Payload>("pin-ocr-show", ({ payload }) => {
      setText(payload.text ?? "");
      setError(payload.error ?? "");
    });
    const ready = listen("pin-ocr-ready-request", () => void emit("pin-ocr-ready"));
    void emit("pin-ocr-ready");
    return () => { show.then((fn) => fn()); ready.then((fn) => fn()); };
  }, []);
  const copy = async () => {
    if (!text) return;
    await invoke("copy_text", { text });
  };
  return <main className="pin-ocr-result" role="dialog" aria-label="OCR 结果">
    <header><strong>OCR 结果</strong><button type="button" aria-label="关闭" onClick={() => void win.hide()}><X size={16} /></button></header>
    {error ? <p className="pin-ocr-error">{error}</p> : <textarea aria-label="OCR 识别文本" value={text} onChange={(e) => setText(e.target.value)} />}
    <footer><button type="button" onClick={() => void copy()} disabled={!text}><Copy size={15} />复制文本</button></footer>
  </main>;
}
