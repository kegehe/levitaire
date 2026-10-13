import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { buildCursorSkin, normalizeCursorColor } from "../../../utils/cursorSkin";
import type { ActiveTool, Annotation, ToolKind } from "./types";
import { DEFAULT_COLOR, fontSizeFor, numberFontSizeFor, numberRadiusFor } from "./types";
import { normalizeRect, renderAll } from "./render";
import { hitTestAnnotation, toleranceFor, type EditHit } from "./edit";
import type { UseAnnotations } from "./useAnnotations";

export interface AnnotationCanvasHandle {
  /** 把当前 canvas 内容导出为纯 base64 PNG（不含 data: 前缀） */
  flushBase64: () => string | null;
  /** 底图是否已加载就绪，导出前需就绪 */
  isReady: () => boolean;
  /**
   * 预解码一张底图。调用方应在**切换 image 之前** await 它：这样新 image 落地的第一帧
   * 就能画上新底图，中间不会出现「画布已经挪到新选区、底图却还是空的」的空白帧，
   * 也不会留下 isReady() 为 false 的窗口（那段窗口里导出会静默退化成未标注的原图）。
   * 失败（base64 损坏等）时 reject，调用方可忽略并退回常规的异步加载路径。
   */
  preload: (base64: string) => Promise<void>;
  /** client 坐标 → 画布内部物理像素；canvas 未挂载或尺寸为 0 时返回 null */
  toPhysical: (clientX: number, clientY: number) => { x: number; y: number } | null;
  /** 命中测试已生效标注（最上层优先）：返回被命中的标注与其部位，未命中返回 null */
  hitTest: (clientX: number, clientY: number) => EditHit | null;
}

interface Props {
  image: { base64: string; width: number; height: number };
  selection: { left: number; top: number; width: number; height: number };
  scale: number;
  tool: ActiveTool;
  color: string;
  /** 当前工具的线宽（物理像素，已由父组件钳制）；文字/序号的字号由它派生 */
  strokeWidth: number;
  annotations: UseAnnotations;
  /** 当前选中的标注 id（仅「移动」工具下由父组件传入）：用于绘制编辑手柄 */
  selectedId?: string | null;
  /** 文字输入提交时回调，便于父组件同步 */
  onCommit?: () => void;
}

/**
 * 截图标注光标（十字准星 + 颜色徽章）。几何、叠色、热点**全部来自 utils/cursorSkin**——
 * 屏幕草稿（SketchTool）用的是同一套外壳，要改光标外观请改那边，别在这里再抄一份副本。
 * 本模块只负责「每个工具画什么符号」；三条硬约束见 cursorSkin.ts 顶部注释。
 * 热点 = 十字交点 (16,16)：六个工具的落笔点都正好是点击处（矩形/马赛克左上角、
 * 箭头/画笔起点、序号圆心、文字左上角）。
 */

/**
 * 徽章里的工具图形，坐标写在 10×10 单位框内（框的尺寸与缩放见 cursorSkin.ts）。
 * 32px 下这些符号只有 6px 左右，所以**只保留最少、最粗的特征**——细节一多就在 1× 下糊掉
 * （马赛克原先是 4 个描边小方块、序号是 #，实测都糊成一团，改成实心块／"1"）。
 * `fill="__INK__"` 由 buildCursorSkin() 按底色亮度替换成墨色，用于实心符号。
 */
const CURSOR_GLYPHS: Record<ToolKind, string> = {
  rect: '<path d="M1.7 1.7h6.6v6.6h-6.6z"/>',
  arrow: '<path d="M1.6 8.4 8.4 1.6M4.4 1.6h4v4"/>',
  brush: '<path d="M1.4 8.6 5.1 2.4 8.6 5.9z" fill="__INK__"/>',
  text: '<path d="M1.8 2.1h6.4M5 2.1v6.4M3.1 8.5h3.8"/>',
  number: '<path d="M3.3 3.5 5.7 1.9v6.4M3 8.3h5.4"/>',
  mosaic: '<path d="M1.4 1.4h3.5v3.5h-3.5zM5.1 5.1h3.5v3.5h-3.5z" fill="__INK__"/>',
};

export function annotationCursor(tool: ToolKind, color: string): string {
  return buildCursorSkin(normalizeCursorColor(color, DEFAULT_COLOR), CURSOR_GLYPHS[tool]);
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `a_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, Props>(function AnnotationCanvas(
  { image, selection, scale, tool, color, strokeWidth, annotations, selectedId, onCommit },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [baseImg, setBaseImg] = useState<HTMLImageElement | null>(null);
  // 已解码底图对应的 image.base64，用于判断底图是否还是"当前这张"
  const loadedSrcRef = useRef<string | null>(null);
  // 预解码好的底图（见 handle.preload）。渲染时按 base64 精确命中，命中就不必再异步加载。
  const preloadedRef = useRef<{ base64: string; img: HTMLImageElement } | null>(null);
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

  const { committed, draft, setDraft, commit, getCommitted } = annotations;
  // 被选中的标注。编辑时 draft 与选中项同 id，故优先用 draft —— 手柄跟着拖动中的预览走。
  const selectedAnn = useMemo(() => {
    if (!selectedId) return null;
    if (draft && draft.id === selectedId) return draft;
    return committed.find((a) => a.id === selectedId) ?? null;
  }, [selectedId, draft, committed]);
  // 移动工具不画图，用系统标准移动光标而不是「十字 + 徽章」皮肤（那套皮肤是落笔点提示，
  // 对不落笔的工具是误导）；四个方向的缩放光标由选区手柄自身的 CSS 负责。
  const cursor = useMemo(
    () => (tool === "move" ? "move" : annotationCursor(tool, color)),
    [tool, color],
  );

  // 底图加载。记下「当前这份 baseImg 对应哪张图」，见下面的 baseImgForRender。
  // 若这张图已经被 preload 预解码过，这里就不重复解码（预解码结果由渲染分支直接取用）。
  useEffect(() => {
    if (preloadedRef.current?.base64 === image.base64) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      loadedSrcRef.current = image.base64;
      setBaseImg(img);
    };
    img.src = `data:image/png;base64,${image.base64}`;
    return () => {
      cancelled = true;
    };
  }, [image.base64]);

  /**
   * 底图与当前 image 不一致时一律不画。
   *
   * 选区调整后，canvas 会先随新的 selection 挪到新位置，而新底图还要几十毫秒才解码完；
   * 这期间若继续用旧 baseImg 绘制，上屏的就是一帧错位像素（canvas 在新位置、内容是旧裁剪）。
   * 不能靠「用 effect 把 baseImg 置 null」来挡：effect 在本次绘制**之后**才跑，那一帧照样画出去。
   * 清空后 canvas 全透明，露出的实时桌面在新位置反而是对的。
   *
   * 必须用渲染期取值（而不是把预解码结果塞进 state）：切换 image 的那一次渲染就要拿到新底图，
   * 否则第一帧仍是空画布，白闪一帧。
   */
  const preloaded = preloadedRef.current;
  const baseImgForRender =
    preloaded && preloaded.base64 === image.base64
      ? preloaded.img
      : loadedSrcRef.current === image.base64
        ? baseImg
        : null;

  // 重绘
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderAll(ctx, baseImgForRender, committed, draft, selectedAnn, scale);
  }, [committed, draft, baseImgForRender, selectedAnn, scale]);

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
    // 这是**导出**路径：selected 传 null，不把选中手柄画进结果图（手柄只是交互提示）。
    // 只读 ref（getCommitted/getDraft），无需依赖 committed/draft。
    renderAll(
      ctx,
      baseImgForRender,
      annotations.getCommitted(),
      annotations.getDraft(),
      null,
      scale,
    );
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
        strokeWidth,
        x: te.x,
        y: te.y,
        fontSize: fontSizeFor(strokeWidth),
        text: v,
      });
      onCommit?.();
    }
    setTextEditing(null);
    composingRef.current = false;
  };

  // 把指针 client 坐标换算为画布内部物理像素坐标。
  // 用 canvas 实际 rect 与内部尺寸求比例（而不是拿 selection.left/scale 反推）：
  // 底图内部宽高是 round(selection.width*scale)，反推会有亚像素偏差。
  const toPhysical = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const toCanvas = (clientX: number, clientY: number) =>
    toPhysical(clientX, clientY) ?? { x: 0, y: 0 };

  // 命中测试已生效标注（最上层优先）。读 ref（getCommitted）避免闭包陈旧；
  // 供父组件在「移动」工具下决定：命中标注则编辑它，否则调整选区。
  const hitTest = useCallback(
    (clientX: number, clientY: number): EditHit | null => {
      const p = toPhysical(clientX, clientY);
      if (!p) return null;
      const tol = toleranceFor(scale);
      const list = getCommitted();
      for (let i = list.length - 1; i >= 0; i--) {
        const zone = hitTestAnnotation(list[i], p.x, p.y, tol);
        if (zone) return { annotation: list[i], zone };
      }
      return null;
    },
    [toPhysical, scale, getCommitted],
  );

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
      isReady: () => baseImgForRender !== null,
      preload: (base64: string) =>
        new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            preloadedRef.current = { base64, img };
            resolve();
          };
          img.onerror = () => reject(new Error("底图预解码失败"));
          img.src = `data:image/png;base64,${base64}`;
        }),
      toPhysical,
      hitTest,
    }),
    // flushBase64 通过 getCommitted/getDraft/textEditingRef 读最新值，无需依赖 committed/draft；
    // syncRender 的闭包只用 baseImgForRender/scale，连同 color/strokeWidth（finishText）一并保留。
    [baseImgForRender, color, strokeWidth, scale, toPhysical, hitTest],
  );

  const onPointerDown = (e: ReactPointerEvent) => {
    if (tool === "move") return; // 移动工具的事件由选区调整层接管（canvas 本身也 pointer-events:none）
    // 若有正在编辑的文字，先提交，再处理新操作
    if (textEditingRef.current) finishText();
    const p = toCanvas(e.clientX, e.clientY);
    const sw = strokeWidth;

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
        radius: numberRadiusFor(sw),
        fontSize: numberFontSizeFor(sw),
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
    if (tool === "move" || tool === "text" || tool === "number") return;
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
    if (tool === "move" || tool === "text" || tool === "number") return;
    const start = startRef.current;
    if (!start) return;
    startRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const p = toCanvas(e.clientX, e.clientY);
    const sw = strokeWidth;
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
        fontSize: `${fontSizeFor(strokeWidth) / scale}px`,
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
          cursor,
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
