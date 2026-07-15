import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import type { AreaMode, WindowInfo, RecordRegion } from "./recordingConfig";

interface AreaSelectorProps {
  onAreaSelected: (region: RecordRegion) => void;
  onCancel: () => void;
}

/** 区域选择组件：全屏 / 区域拖框 / 窗口识别 */
function AreaSelector({ onAreaSelected, onCancel }: AreaSelectorProps) {
  const [areaMode, setAreaMode] = useState<AreaMode>("region");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedWindow, setSelectedWindow] = useState<WindowInfo | null>(null);
  const [ready, setReady] = useState(false);
  const scaleRef = useRef<number>(1);
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const win = getCurrentWebviewWindow();

  // 获取 DPI 缩放和虚拟桌面原点
  const fetchReady = useCallback(() => {
    let scaleReady = false;
    let originReady = false;
    const markReady = () => {
      if (scaleReady && originReady) {
        setReady(true);
      }
    };
    win.scaleFactor()
      .then((s) => {
        scaleRef.current = s;
        scaleReady = true;
        markReady();
      })
      .catch((e) => console.error("scaleFactor failed:", e));
    invoke<{ originX: number; originY: number; width: number; height: number }>(
      "get_virtual_desktop_bounds",
    )
      .then((b) => {
        originRef.current = { x: b.originX, y: b.originY };
        originReady = true;
        markReady();
      })
      .catch((e) => console.error("get_virtual_desktop_bounds failed:", e));
  }, [win]);

  useEffect(() => {
    fetchReady();
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, [fetchReady]);

  // 加载窗口列表（窗口识别模式），切换时清理旧状态
  useEffect(() => {
    if (areaMode === "window") {
      invoke<WindowInfo[]>("enumerate_windows").then(setWindows).catch(console.error);
    } else {
      setWindows([]);
      setSelectedWindow(null);
    }
  }, [areaMode]);

  const snap = useCallback((cssPx: number) => {
    const s = scaleRef.current || 1;
    return Math.round(cssPx * s) / s;
  }, []);

  // 全屏模式：直接使用虚拟桌面边界
  const selectFullscreen = async () => {
    try {
      const bounds = await invoke<{ originX: number; originY: number; width: number; height: number }>(
        "get_virtual_desktop_bounds",
      );
      onAreaSelected({
        left: bounds.originX,
        top: bounds.originY,
        width: bounds.width,
        height: bounds.height,
      });
    } catch (err) {
      console.error("get_virtual_desktop_bounds failed:", err);
    }
  };

  // 窗口识别：选中某个窗口
  const selectWindow = (w: WindowInfo) => {
    setSelectedWindow(w);
    onAreaSelected({
      left: w.left,
      top: w.top,
      width: w.width,
      height: w.height,
    });
  };

  // 区域拖框
  const onPointerDown = (e: React.PointerEvent) => {
    if (areaMode !== "region" || !ready) return;
    const x = snap(e.clientX);
    const y = snap(e.clientY);
    dragStart.current = { x, y };
    setSelection({ left: x, top: y, width: 0, height: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (areaMode !== "region" || !dragStart.current) return;
    const start = dragStart.current;
    const cx = snap(e.clientX);
    const cy = snap(e.clientY);
    setSelection({
      left: Math.min(start.x, cx),
      top: Math.min(start.y, cy),
      width: Math.abs(cx - start.x),
      height: Math.abs(cy - start.y),
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (areaMode !== "region" || !dragStart.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const start = dragStart.current;
    dragStart.current = null;
    const cx = snap(e.clientX);
    const cy = snap(e.clientY);
    const left = Math.min(start.x, cx);
    const top = Math.min(start.y, cy);
    const width = Math.abs(cx - start.x);
    const height = Math.abs(cy - start.y);

    if (width < 3 || height < 3) {
      setSelection(null);
      return;
    }

    const scale = scaleRef.current;
    const origin = originRef.current;
    onAreaSelected({
      left: Math.round(left * scale) + origin.x,
      top: Math.round(top * scale) + origin.y,
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    });
  };

  return (
    <div
      className="rec-area-overlay"
      onPointerDown={areaMode === "region" ? onPointerDown : undefined}
      onPointerMove={areaMode === "region" ? onPointerMove : undefined}
      onPointerUp={areaMode === "region" ? onPointerUp : undefined}
    >
      {/* 顶部模式切换栏 */}
      <div className="rec-area-tabs" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className={`rec-area-tab ${areaMode === "fullscreen" ? "active" : ""}`}
          onClick={() => setAreaMode("fullscreen")}
        >
          <Icon name="Monitor" size={14} /> 全屏
        </button>
        <button
          className={`rec-area-tab ${areaMode === "region" ? "active" : ""}`}
          onClick={() => setAreaMode("region")}
        >
          <Icon name="Scissors" size={14} /> 区域
        </button>
        <button
          className={`rec-area-tab ${areaMode === "window" ? "active" : ""}`}
          onClick={() => setAreaMode("window")}
        >
          <Icon name="AppWindow" size={14} /> 窗口
        </button>
        <button className="rec-area-cancel" onClick={onCancel}>
          取消
        </button>
      </div>

      {/* 区域拖框模式 */}
      {areaMode === "region" && (
        <>
          {selection && selection.width > 0 && selection.height > 0 && (
            <>
              <div className="ss-mask" style={{ left: 0, top: 0, width: "100%", height: `${selection.top}px` }} />
              <div className="ss-mask" style={{ left: 0, top: selection.top + selection.height, width: "100%", bottom: 0 }} />
              <div className="ss-mask" style={{ left: 0, top: selection.top, width: `${selection.left}px`, height: selection.height }} />
              <div className="ss-mask" style={{ left: selection.left + selection.width, top: selection.top, right: 0, height: selection.height }} />
              <div
                className="rec-selection-box"
                style={{
                  left: selection.left,
                  top: selection.top,
                  width: selection.width,
                  height: selection.height,
                }}
              />
              <div
                className="ss-size-badge"
                style={{
                  left: selection.left,
                  top: selection.top >= 22 ? selection.top - 22 : selection.top + 4,
                }}
              >
                {Math.round(selection.width * (scaleRef.current || 1))} ×{" "}
                {Math.round(selection.height * (scaleRef.current || 1))}
              </div>
            </>
          )}
          {(!selection || (selection.width === 0 && selection.height === 0)) && (
            <div className="ss-hint" style={{ color: "#ff6b6b" }}>
              {ready ? "拖动鼠标选择录制区域" : "正在准备…"}
            </div>
          )}
        </>
      )}

      {/* 全屏模式 */}
      {areaMode === "fullscreen" && (
        <div className="rec-fullscreen-panel" onPointerDown={(e) => e.stopPropagation()}>
          <p>将录制整个屏幕</p>
          <button className="rec-area-confirm" onClick={selectFullscreen}>
            开始选择
          </button>
        </div>
      )}

      {/* 窗口识别模式 */}
      {areaMode === "window" && (
        <div className="rec-window-list" onPointerDown={(e) => e.stopPropagation()}>
          {windows.length === 0 ? (
            <p className="rec-window-empty">未检测到可录制的窗口</p>
          ) : (
            windows.map((w) => (
              <button
                key={w.hwnd}
                className={`rec-window-item ${selectedWindow?.hwnd === w.hwnd ? "selected" : ""}`}
                onClick={() => selectWindow(w)}
              >
                <Icon name="AppWindow" size={16} />
                <div className="rec-window-item-info">
                  <span className="rec-window-item-title">{w.title}</span>
                  <span className="rec-window-item-size">{w.width}×{w.height}</span>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default AreaSelector;
