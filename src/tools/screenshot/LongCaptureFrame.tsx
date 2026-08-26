import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import "./LongCaptureFrame.css";

function LongCaptureFrame() {
  useEffect(() => {
    const unReadyRequest = listen("long-capture-frame-ready-request", () => {
      void emit("long-capture-frame-ready");
    });
    void emit("long-capture-frame-ready");
    return () => {
      unReadyRequest.then((fn) => fn());
    };
  }, []);

  return <div className="long-capture-frame" aria-hidden="true" />;
}

export default LongCaptureFrame;
