import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Icon from "../../components/Icon";
import AnnotationCanvas, {
  type AnnotationCanvasHandle,
} from "./annotate/AnnotationCanvas";
import AnnotationToolbar from "./annotate/AnnotationToolbar";
import { useAnnotations } from "./annotate/useAnnotations";
import {
  DEFAULT_COLOR,
  DEFAULT_TOOL,
  DEFAULT_WIDTH_INDEX,
  type ToolKind,
} from "./annotate/types";
import "./ScreenshotTool.css";

/** 截图模式：绘制选区 / 选区完成后进入标注 */
type Mode = "selecting" | "annotating";

interface Selection {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CapturedImage {
  base64: string;
  width: number;
  height: number;
}

interface PanelPosition {
  left: number;
  top: number;
}

const OCR_PANEL_WIDTH = 420;
const OCR_PANEL_HEIGHT = 300;
const OCR_PANEL_GAP = 10;
const VIEWPORT_PADDING = 12;

function initialOcrPanelPosition(selection: Selection): PanelPosition {
  const width = Math.min(OCR_PANEL_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
  const height = Math.min(OCR_PANEL_HEIGHT, window.innerHeight - VIEWPORT_PADDING * 2);
  const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
  const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);
  const below = selection.top + selection.height + OCR_PANEL_GAP;
  const top = below + height <= window.innerHeight - VIEWPORT_PADDING
    ? below
    : selection.top - height - OCR_PANEL_GAP;

  return {
    left: Math.max(VIEWPORT_PADDING, Math.min(selection.left, maxLeft)),
    top: Math.max(VIEWPORT_PADDING, Math.min(top, maxTop)),
  };
}

function ScreenshotTool() {
  const win = getCurrentWebviewWindow();
  const [mode, setMode] = useState<Mode>("selecting");
  const modeRef = useRef<Mode>("selecting");
  modeRef.current = mode;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [image, setImage] = useState<CapturedImage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrSelection, setOcrSelection] = useState("");
  const [ocrPanelPosition, setOcrPanelPosition] = useState<PanelPosition | null>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const scaleRef = useRef<number>(1);
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // 代际计数：cancel 时自增，异步回调 await 后比对，不等则丢弃结果，避免取消后状态复活
  const genRef = useRef(0);
  // 抑制失焦重置：save_image 等会弹系统对话框夺焦，此时不应重置截图状态
  const suppressFocusReset = useRef(false);
  // 错误提示自动清除的计时器句柄
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ocrTextRef = useRef<HTMLTextAreaElement>(null);
  const ocrPanelDrag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  // 失焦退出防抖计时器：失焦后延迟一小段时间再退出，期间若重新获焦则取消，
  // 兼顾「失焦应退出标注态」与「RDP/远程桌面等环境下 overlay 频繁瞬时失焦」。
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 标注
  const annotations = useAnnotations();
  const clearRef = useRef(annotations.clear);
  clearRef.current = annotations.clear;
  const annotateRef = useRef<AnnotationCanvasHandle>(null);
  const [tool, setTool] = useState<ToolKind>(DEFAULT_TOOL);
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [widthIndex, setWidthIndex] = useState<number>(DEFAULT_WIDTH_INDEX);

  // 显示一条临时错误提示（4 秒后自动清除），用于 OCR 等失败时给用户可见反馈
  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 4000);
  }, []);

  // 透明背景 + scale + 虚拟桌面原点（用于把窗口相对坐标换算为虚拟桌面绝对物理坐标）
  // 两者都就绪前禁止交互，避免坐标换算用默认值导致错位
  // 拉取失败时 ready 保持 false，由 onFocusChanged 获焦重试，避免永久卡死
  const fetchReady = useCallback(() => {
    let scaleReady = false;
    let originReady = false;
    const markReady = () => {
      if (scaleReady && originReady) {
        readyRef.current = true;
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
    const root = document.getElementById("root");
    if (root) {
      root.style.background = "transparent";
      root.style.margin = "0";
      root.style.overflow = "hidden";
    }
  }, [win, fetchReady]);

  // Esc 取消 + Ctrl+Z/Y 撤销重做（标注态）
  const cancelRef = useRef<() => void>(() => {});
  const undoRef = useRef(annotations.undo);
  const redoRef = useRef(annotations.redo);
  undoRef.current = annotations.undo;
  redoRef.current = annotations.redo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 文字输入聚焦时不拦截 Ctrl+Z/Y，交给 textarea 处理
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inTextInput = tag === "TEXTAREA" || tag === "INPUT";
      if (e.key === "Escape") {
        cancelRef.current();
        return;
      }
      if (inTextInput) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        if (e.shiftKey) {
          e.preventDefault();
          redoRef.current();
        } else {
          e.preventDefault();
          undoRef.current();
        }
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 监听后端全局 Esc 退出事件（透明全屏窗口失焦时前端 keydown 可能收不到，
  // 由 WH_KEYBOARD_LL 全局钩子触发 screenshot-cancelled 兜底）
  useEffect(() => {
    const un = listen("screenshot-cancelled", () => {
      // save_image/pin_image 夺焦期间（弹系统对话框）忽略全局 Esc，避免与对话框取消冲突清空标注
      if (suppressFocusReset.current) return;
      genRef.current++;
      setSelection(null);
      setMode("selecting");
      setImage(null);
      setBusy(null);
      setOcrText(null);
      setOcrSelection("");
      setOcrPanelPosition(null);
      dragStart.current = null;
      // 同步清空标注与失焦抑制，避免下次截图残留
      clearRef.current();
      suppressFocusReset.current = false;
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 失焦退出标注态：普通失焦（切走窗口、系统弹窗等）应清空截图状态，
  // 但 save/pin 弹系统对话框夺焦期间由 suppressFocusReset 抑制，避免与对话框冲突。
  // 加防抖：RDP/远程桌面下 overlay 会频繁瞬时失焦，延迟 250ms 再退出，
  // 期间若重新获焦则取消退出，避免截图模式被瞬时失焦误关。
  useEffect(() => {
    const un = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        if (blurTimer.current) {
          clearTimeout(blurTimer.current);
          blurTimer.current = null;
        }
        if (!readyRef.current) {
          fetchReady();
        }
        return;
      }
      // 框选态必须容忍焦点短暂切换。全局热键唤起时 Windows 可能在
      // overlay show/set_focus 后补发一次失焦事件；此时取消会让遮罩闪退。
      // Esc 已由全局键盘钩子兜底，因此框选态仍可可靠退出。
      if (modeRef.current === "selecting") return;
      // 失焦：suppressFocusReset 期间（save/pin/copy 夺焦）不退出
      if (suppressFocusReset.current) return;
      if (blurTimer.current) clearTimeout(blurTimer.current);
      blurTimer.current = setTimeout(() => {
        blurTimer.current = null;
        cancelRef.current();
      }, 250);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [win, fetchReady]);

  // 组件卸载时清除计时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  const cancel = useCallback(() => {
    // 自增代际，使进行中的异步回调（capture/ocr/pin 等）失效
    genRef.current++;
    // 重置组件状态，避免 overlay 复用时残留上次的选区/图片
    setSelection(null);
    setMode("selecting");
    setImage(null);
    setBusy(null);
    setOcrText(null);
    setOcrSelection("");
    setOcrPanelPosition(null);
    setError(null);
    suppressFocusReset.current = false;
    clearRef.current();
    if (errorTimer.current) {
      clearTimeout(errorTimer.current);
      errorTimer.current = null;
    }
    dragStart.current = null;
    invoke("cancel_screenshot").catch(console.error);
  }, []);
  cancelRef.current = cancel;

  // 把浮点 CSS 坐标对齐到「整数物理像素」对应的 CSS 坐标。
  // 高 DPI（如 150%）下，整数 CSS px 不一定是整数物理 px（CSS 100→物理 150 整数，但 CSS 101→物理 151.5）。
  // 浏览器对非整数物理像素的盒模型边缘做子像素抗锯齿，导致蓝色边框向选区内部渗透
  // （视觉上“框线跑到截图内部”）。这里先换算到物理像素 round，再除回 CSS px，
  // 保证选区盒子的四条边都落在整数物理像素上，消除子像素渗透。
  const snap = useCallback((cssPx: number) => {
    const s = scaleRef.current || 1;
    return Math.round(cssPx * s) / s;
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (mode !== "selecting" || busy || !ready) return;
    const x = snap(e.clientX);
    const y = snap(e.clientY);
    dragStart.current = { x, y };
    setSelection({ left: x, top: y, width: 0, height: 0 });
    // 用 currentTarget（overlay 根 div，稳定存在）而非 target，避免重渲染替换子节点时丢失捕获
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (mode !== "selecting" || !dragStart.current) return;
    const start = dragStart.current;
    const cx = snap(e.clientX);
    const cy = snap(e.clientY);
    const left = Math.min(start.x, cx);
    const top = Math.min(start.y, cy);
    const width = Math.abs(cx - start.x);
    const height = Math.abs(cy - start.y);
    setSelection({ left, top, width, height });
  };

  const onPointerUp = async (e: React.PointerEvent) => {
    if (mode !== "selecting" || !dragStart.current) return;
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
      // 选区过小，取消
      cancel();
      return;
    }
    const scale = scaleRef.current;
    const origin = originRef.current;
    const phys: Selection = {
      left: Math.round(left * scale) + origin.x,
      top: Math.round(top * scale) + origin.y,
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
    setSelection({ left, top, width, height });
    setBusy("capture");
    // 代际在 await 前捕获：capture_region 期间若用户 Esc 取消，genRef 自增，
    // await 返回后比对即可丢弃这次已取消的截屏，避免状态复活。
    // capture_region 从 start_screenshot 时截取的全屏缓存裁剪，不 hide/show overlay，
    // 不触发失焦，故无需 suppressFocusReset。
    const gen = genRef.current;
    try {
      const res = await invoke<{ pngBase64: string; width: number; height: number }>(
        "capture_region",
        { left: phys.left, top: phys.top, width: phys.width, height: phys.height },
      );
      // 若期间已取消（Esc / 窗口隐藏），丢弃结果
      if (gen !== genRef.current) return;
      setImage({ base64: res.pngBase64, width: res.width, height: res.height });
      setMode("annotating");
    } catch (err) {
      console.error("capture_region failed:", err);
      cancel();
    } finally {
      if (gen === genRef.current) {
        setBusy(null);
      }
    }
  };

  // 导出前把标注烧入底图，得到含标注的纯 base64
  const flushAnnotated = useCallback((): string | null => {
    if (!annotateRef.current) return image?.base64 ?? null;
    if (!annotateRef.current.isReady()) return null;
    return annotateRef.current.flushBase64();
  }, [image]);

  // 小工具栏按钮
  const copyToClipboard = async () => {
    if (!image) return;
    setBusy("copy");
    try {
      const b64 = flushAnnotated() ?? image.base64;
      await invoke("clipboard_set_image", { base64Data: b64 });
      cancel();
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(null);
    }
  };

  const saveFile = async () => {
    if (!image) return;
    setBusy("save");
    // save_image 会弹系统保存对话框夺焦，抑制期间的失焦重置，避免截图状态被清空
    suppressFocusReset.current = true;
    try {
      const b64 = flushAnnotated() ?? image.base64;
      await invoke<boolean>("save_image", {
        base64Data: `data:image/png;base64,${b64}`,
        filename: "screenshot.png",
      });
      // 原生保存框无论确认还是取消都结束本次截图会话，与截图工具的
      // "保存完即完成" 交互一致，避免用户回到已失效的标注状态。
      cancel();
    } catch (err) {
      console.error(err);
      showError(
        typeof err === "string"
          ? err
          : (err as { message?: string })?.message ?? "保存失败",
      );
    } finally {
      suppressFocusReset.current = false;
      setBusy(null);
    }
  };

  const ocr = async () => {
    if (!selection || busy) return;
    const scale = scaleRef.current;
    const origin = originRef.current;
    const gen = genRef.current;
    setBusy("ocr");
    setError(null);
    try {
      const text = await invoke<string>("ocr_region", {
        left: Math.round(selection.left * scale) + origin.x,
        top: Math.round(selection.top * scale) + origin.y,
        width: Math.round(selection.width * scale),
        height: Math.round(selection.height * scale),
      });
      if (gen !== genRef.current) return;
      if (!text.trim()) {
        showError("未识别到文字");
        return;
      }
      setOcrText(text);
      setOcrSelection("");
      setOcrPanelPosition(initialOcrPanelPosition(selection));
      requestAnimationFrame(() => ocrTextRef.current?.focus());
    } catch (err) {
      console.error("ocr_region failed:", err);
      showError(typeof err === "string" ? err : (err as { message?: string })?.message ?? "OCR 识别失败");
    } finally {
      if (gen === genRef.current) {
        setBusy(null);
      }
    }
  };

  const copyOcrText = async (text: string) => {
    if (!text) return;
    setBusy("copy");
    try {
      await invoke("copy_text", { text });
    } catch (err) {
      console.error("copy OCR text failed:", err);
      showError(typeof err === "string" ? err : "复制 OCR 文本失败");
    } finally {
      setBusy(null);
    }
  };

  const updateOcrSelection = () => {
    const textarea = ocrTextRef.current;
    if (!textarea) return;
    setOcrSelection(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd));
  };

  const startOcrPanelDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    ocrPanelDrag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveOcrPanel = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = ocrPanelDrag.current;
    const panel = event.currentTarget.parentElement;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    const rect = panel.getBoundingClientRect();
    setOcrPanelPosition({
      left: Math.max(0, Math.min(event.clientX - drag.offsetX, window.innerWidth - rect.width)),
      top: Math.max(0, Math.min(event.clientY - drag.offsetY, window.innerHeight - rect.height)),
    });
  };

  const stopOcrPanelDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (ocrPanelDrag.current?.pointerId !== event.pointerId) return;
    ocrPanelDrag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const pinToDesktop = async () => {
    if (!image || !selection) return;
    const scale = scaleRef.current;
    const origin = originRef.current;
    setBusy("pin");
    // pin_image 创建新窗口会短暂夺焦，抑制期间的失焦重置
    suppressFocusReset.current = true;
    try {
      const b64 = flushAnnotated() ?? image.base64;
      await invoke("pin_image", {
        base64Data: b64,
        x: Math.round(selection.left * scale) + origin.x,
        y: Math.round(selection.top * scale) + origin.y,
        width: image.width,
        height: image.height,
      });
      cancel();
    } catch (err) {
      console.error("pin_image failed:", err);
      // pin 失败也要退出截图模式，否则 overlay 全屏置顶卡死无法退出
      cancel();
    } finally {
      suppressFocusReset.current = false;
      setBusy(null);
    }
  };

  return (
    <div
      className="ss-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* 半透明遮罩：用 4 个 div 框出选区外的区域。尺寸标签仅在 selecting 时显示，
          参照 Snipaste：选区完成后只留工具栏，避免标签与工具栏并存干扰。
          截图瞬间 Rust 侧会临时 hide 整个 overlay 窗口，选区框/遮罩随之从屏幕消失，
          不会被 GDI 截入底图，因此前端无需在此条件渲染上做额外处理。 */}
      {selection && selection.width > 0 && selection.height > 0 && (
        <>
          <div className="ss-mask" style={{ left: 0, top: 0, width: "100%", height: `${selection.top}px` }} />
          <div className="ss-mask" style={{ left: 0, top: selection.top + selection.height, width: "100%", bottom: 0 }} />
          <div className="ss-mask" style={{ left: 0, top: selection.top, width: `${selection.left}px`, height: selection.height }} />
          <div className="ss-mask" style={{ left: selection.left + selection.width, top: selection.top, right: 0, height: selection.height }} />
          <div className="ss-selection-box" style={boxStyle(selection)} />
          {mode === "selecting" && (
            <div
              className="ss-size-badge"
              style={sizeBadgeStyle(selection)}
            >
              {Math.round(selection.width * (scaleRef.current || 1))} ×{" "}
              {Math.round(selection.height * (scaleRef.current || 1))}
            </div>
          )}
        </>
      )}
      {(!selection || (selection.width === 0 && selection.height === 0)) && (
        <div className="ss-hint">
          {ready ? "拖动鼠标选择截图区域，按 Esc 取消" : "正在准备截图…"}
        </div>
      )}

      {mode === "annotating" && selection && image && (
        <>
          <AnnotationCanvas
            ref={annotateRef}
            image={image}
            selection={selection}
            scale={scaleRef.current || 1}
            tool={tool}
            color={color}
            widthIndex={widthIndex}
            annotations={annotations}
          />
          <AnnotationToolbar
            tool={tool}
            setTool={setTool}
            color={color}
            setColor={setColor}
            widthIndex={widthIndex}
            setWidthIndex={setWidthIndex}
            annotations={annotations}
            busy={busy}
            error={error}
            ready={true}
            onCopy={copyToClipboard}
            onSave={saveFile}
            onOcr={ocr}
            onPin={pinToDesktop}
            onCancel={cancel}
            style={{
              left: selection.left,
              top: selection.top + selection.height + 6,
            }}
          />
          {ocrText !== null && (
            <div
              className="ss-ocr-result"
              role="dialog"
              aria-modal="true"
              aria-label="OCR 结果"
              onPointerDown={(event) => event.stopPropagation()}
              style={
                ocrPanelPosition
                  ? { ...ocrPanelPosition, transform: "none" }
                  : undefined
              }
            >
              <div
                className="ss-ocr-result-header"
                onPointerDown={startOcrPanelDrag}
                onPointerMove={moveOcrPanel}
                onPointerUp={stopOcrPanelDrag}
              >
                <span>OCR 结果</span>
                <button
                  className="ss-btn"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    setOcrText(null);
                    setOcrPanelPosition(null);
                  }}
                  aria-label="关闭 OCR 结果"
                  data-tooltip="关闭"
                >
                  <Icon name="X" size={16} />
                </button>
              </div>
              <textarea
                ref={ocrTextRef}
                className="ss-ocr-result-text"
                value={ocrText}
                onChange={(event) => {
                  setOcrText(event.target.value);
                  setOcrSelection("");
                }}
                onSelect={updateOcrSelection}
                aria-label="OCR 识别文本"
                spellCheck={false}
              />
              <div className="ss-ocr-result-actions">
                <button
                  className="ss-ocr-action"
                  onClick={() => copyOcrText(ocrSelection)}
                  disabled={!ocrSelection || !!busy}
                >
                  复制选中
                </button>
                <button
                  className="ss-ocr-action ss-ocr-action-primary"
                  onClick={() => copyOcrText(ocrText)}
                  disabled={!ocrText || !!busy}
                >
                  复制全部
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function boxStyle(sel: Selection): React.CSSProperties {
  return {
    left: sel.left,
    top: sel.top,
    width: sel.width,
    height: sel.height,
  };
}

// 尺寸标签定位：参考 Snipaste 放在选区左上角外侧（上方），离选区顶 4px。
// 垂直方向：选区贴屏幕顶（< 标签高度 + 间距 ≈ 22px）时改放选区内部左上角，避免飞出屏幕被裁切。
// 水平方向：默认左对齐选区左边；当选区右边缘距视口右边不足标签宽度（≈ 80px）时，
// 改为右对齐选区右边缘，避免标签溢出视口右边被 .ss-overlay 的 overflow:hidden 裁切。
function sizeBadgeStyle(sel: Selection): React.CSSProperties {
  const BADGE_W = 80;
  const flipX = sel.left + sel.width + BADGE_W > window.innerWidth;
  return flipX
    ? { right: window.innerWidth - (sel.left + sel.width), top: sizeBadgeTop(sel.top) }
    : { left: sel.left, top: sizeBadgeTop(sel.top) };
}

function sizeBadgeTop(selTop: number): number {
  return selTop >= 22 ? selTop - 22 : selTop + 4;
}

export default ScreenshotTool;
