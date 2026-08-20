import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Annotation, ToolKind } from "./types";
import { fontSizeFor, strokeWidthFor } from "./types";
import { normalizeRect, renderAll } from "./render";
import type { UseAnnotations } from "./useAnnotations";

export interface AnnotationCanvasHandle {
  /** 把当前 canvas 内容导出为纯 base64 PNG（不含 data: 前缀） */
  flushBase64: () => string | null;
  /** 底图是否已加载就绪，导出前需就绪 */
  isReady: () => boolean;
}

interface Props {
  image: { base64: string; width: number; height: number };
  selection: { left: number; top: number; width: number; height: number };
  scale: number;
  tool: ToolKind;
  color: string;
  widthIndex: number;
  annotations: UseAnnotations;
  /** 文字输入提交时回调，便于父组件同步 */
  onCommit?: () => void;
}

const TOOL_CURSOR: Record<ToolKind, string> = {
  rect: "crosshair",
  arrow: "crosshair",
  brush: "crosshair",
  text: "text",
  number: "pointer",
  mosaic: "crosshair",
};

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `a_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, Props>(function AnnotationCanvas(
  { image, selection, scale, tool, color, widthIndex, annotations, onCommit },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [baseImg, setBaseImg] = useState<HTMLImageElement | null>(null);
  // 浮动文字输入：在画布物理坐标处显示
  const [textEditing, setTextEditing] = useState<{
    x: number; // 画布内部物理 px
    y: number;
    value: string;
  } | null>(null);
  // textEditing 的 ref 镜像，供 flushBase64/finishText 同步读取，避免闭包陈旧
  const textEditingRef = useRef(textEditing);
  textEditingRef.current = textEditing;
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  // 输入法合成期间不提交
  const composingRef = useRef(false);
  // 当前绘制起点（物理坐标）
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // 画笔 draft 点累积用 ref，避免高频 setState 抖动；但 draft 仍经 annotations.setDraft 提交以触发重绘
  const draftPtsRef = useRef<{ x: number; y: number }[]>([]);

  const { committed, draft, setDraft, commit } = annotations;

  // 底图加载
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setBaseImg(img);
    };
    img.src = `data:image/png;base64,${image.base64}`;
    return () => {
      cancelled = true;
    };
  }, [image.base64]);

  // 重绘
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderAll(ctx, baseImg, committed, draft);
  }, [committed, draft, baseImg]);

  // 文字输入框自动撑高：按内容 scrollHeight 调整，使多行（Shift+Enter / 自动换行）可见。
  // 先置 auto 重置历史高度，再按 scrollHeight 设定；限制最大高度避免超出选区过多。
  useEffect(() => {
    const el = textInputRef.current;
    if (!el || !textEditing) return;
    el.style.height = "auto";
    const maxH = Math.max(40, (selection.height ?? 0) / scale);
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  }, [textEditing, selection.height, scale]);

  // 同步重绘（供 flushBase64 在导出前强制刷新 canvas，避免 commit 后 effect 未 flush 导致导出旧像素）
  // 读 ref（getCommitted/getDraft）而非闭包 state，确保刚 commit 的标注被画上
  const syncRender = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderAll(ctx, baseImg, annotations.getCommitted(), annotations.getDraft());
  };

  // 提交正在编辑的文字（读 ref 防陈旧/防重入）
  const finishText = () => {
    const te = textEditingRef.current;
    if (!te) return;
    // 同步清 ref，防止 flushBase64 或 blur/pointerdown 重复触发导致重复提交
    textEditingRef.current = null;
    const v = te.value.trim();
    if (v) {
      commit({
        id: genId(),
        kind: "text",
        color,
        strokeWidth: strokeWidthFor(widthIndex),
        x: te.x,
        y: te.y,
        fontSize: fontSizeFor(widthIndex),
        text: v,
      });
      onCommit?.();
    }
    setTextEditing(null);
    composingRef.current = false;
  };

  useImperativeHandle(
    ref,
    () => ({
      flushBase64: () => {
        // 导出前先提交未提交的文字，并同步重绘，确保 canvas 含最新所有标注
        if (textEditingRef.current) finishText();
        syncRender();
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const url = canvas.toDataURL("image/png");
        return url.substring(url.indexOf(",") + 1);
      },
      isReady: () => baseImg !== null,
    }),
    // flushBase64 通过 getCommitted/getDraft/textEditingRef 读最新值，无需依赖 committed/draft；
    // 仅 baseImg/color/widthIndex 变化时重建（影响 syncRender/finishText 闭包）
    [baseImg, color, widthIndex],
  );

  // 把指针 client 坐标换算为画布内部物理像素坐标
  const toCanvas = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * sx,
      y: (clientY - rect.top) * sy,
    };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    // 若有正在编辑的文字，先提交，再处理新操作
    if (textEditingRef.current) finishText();
    const p = toCanvas(e.clientX, e.clientY);
    const sw = strokeWidthFor(widthIndex);

    if (tool === "text") {
      // 文字 CSS 坐标 = 物理 / scale + selection.left/top
      setTextEditing({
        x: p.x,
        y: p.y,
        value: "",
      });
      // 聚焦延迟到渲染后
      setTimeout(() => textInputRef.current?.focus(), 0);
      return;
    }

    if (tool === "number") {
      // 用 getCommitted 读 ref 计算序号，避免闭包 nextNumber 在同事件多次 commit 时陈旧
      const committedNow = annotations.getCommitted();
      const n =
        committedNow.reduce((max, a) => (a.kind === "number" && a.n > max ? a.n : max), 0) + 1;
      commit({
        id: genId(),
        kind: "number",
        color,
        strokeWidth: sw,
        x: p.x,
        y: p.y,
        radius: Math.max(sw * 2.5, 12),
        fontSize: Math.max(sw * 3, 14),
        n,
      });
      onCommit?.();
      return;
    }

    // rect / arrow / mosaic：记起点，建 draft
    startRef.current = p;
    if (tool === "rect") {
      setDraft({
        id: genId(),
        kind: "rect",
        color,
        strokeWidth: sw,
        x: p.x,
        y: p.y,
        w: 0,
        h: 0,
      });
    } else if (tool === "arrow") {
      setDraft({
        id: genId(),
        kind: "arrow",
        color,
        strokeWidth: sw,
        x1: p.x,
        y1: p.y,
        x2: p.x,
        y2: p.y,
      });
    } else if (tool === "mosaic") {
      setDraft({
        id: genId(),
        kind: "mosaic",
        color,
        strokeWidth: sw,
        x: p.x,
        y: p.y,
        w: 0,
        h: 0,
        blockSize: 10,
      });
    } else if (tool === "brush") {
      draftPtsRef.current = [p];
      setDraft({
        id: genId(),
        kind: "brush",
        color,
        strokeWidth: sw,
        points: [p],
      });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (tool === "text" || tool === "number") return;
    const start = startRef.current;
    if (!start) return;
    const p = toCanvas(e.clientX, e.clientY);

    if (tool === "rect" || tool === "mosaic") {
      const r = normalizeRect(start.x, start.y, p.x, p.y);
      setDraft((d) =>
        d && (d.kind === "rect" || d.kind === "mosaic")
          ? ({ ...d, x: r.x, y: r.y, w: r.w, h: r.h } as Annotation)
          : d,
      );
    } else if (tool === "arrow") {
      setDraft((d) => (d && d.kind === "arrow" ? ({ ...d, x2: p.x, y2: p.y } as Annotation) : d));
    } else if (tool === "brush") {
      const pts = draftPtsRef.current;
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
      pts.push(p);
      setDraft((d) =>
        d && d.kind === "brush" ? ({ ...d, points: pts.slice() } as Annotation) : d,
      );
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (tool === "text" || tool === "number") return;
    const start = startRef.current;
    if (!start) return;
    startRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const p = toCanvas(e.clientX, e.clientY);
    const sw = strokeWidthFor(widthIndex);
    // 直接构造最终 annotation 提交，不依赖 commitDraft 读 draft ref（避免 React 批处理下 ref 陈旧）
    let ann: Annotation | null = null;
    if (tool === "rect" || tool === "mosaic") {
      const r = normalizeRect(start.x, start.y, p.x, p.y);
      if (r.w < 3 || r.h < 3) {
        setDraft(null);
        draftPtsRef.current = [];
        return;
      }
      if (tool === "rect") {
        ann = {
          id: genId(),
          kind: "rect",
          color,
          strokeWidth: sw,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
        };
      } else {
        ann = {
          id: genId(),
          kind: "mosaic",
          color,
          strokeWidth: sw,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          blockSize: 10,
        };
      }
    } else if (tool === "arrow") {
      if (Math.hypot(p.x - start.x, p.y - start.y) < 3) {
        setDraft(null);
        draftPtsRef.current = [];
        return;
      }
      ann = {
        id: genId(),
        kind: "arrow",
        color,
        strokeWidth: sw,
        x1: start.x,
        y1: start.y,
        x2: p.x,
        y2: p.y,
      };
    } else if (tool === "brush") {
      const pts = draftPtsRef.current;
      if (pts.length < 2) {
        setDraft(null);
        draftPtsRef.current = [];
        return;
      }
      ann = {
        id: genId(),
        kind: "brush",
        color,
        strokeWidth: sw,
        points: pts.slice(),
      };
    }
    if (ann) {
      commit(ann);
      onCommit?.();
    }
    setDraft(null);
    draftPtsRef.current = [];
  };

  // 文字 textarea 的 CSS 位置与字号
  const textCss = textEditing
    ? {
        left: selection.left + textEditing.x / scale,
        top: selection.top + textEditing.y / scale,
        fontSize: `${fontSizeFor(widthIndex) / scale}px`,
        color,
      }
    : null;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="ss-annotate-canvas"
        width={image.width}
        height={image.height}
        style={{
          position: "absolute",
          left: selection.left,
          top: selection.top,
          width: selection.width,
          height: selection.height,
          cursor: TOOL_CURSOR[tool],
          zIndex: 5,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {textEditing && textCss && (
        <textarea
          ref={textInputRef}
          className="ss-text-input"
          style={textCss}
          value={textEditing.value}
          rows={1}
          onChange={(e) => setTextEditing((t) => (t ? { ...t, value: e.target.value } : t))}
          onCompositionStart={() => (composingRef.current = true)}
          onCompositionEnd={() => (composingRef.current = false)}
          onKeyDown={(e) => {
            if (composingRef.current) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              finishText();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setTextEditing(null);
            }
          }}
          onBlur={finishText}
          spellCheck={false}
        />
      )}
    </>
  );
});

export default AnnotationCanvas;
