import Icon from "../../../components/Icon";
import {
  clampStrokeWidth,
  COLOR_AUTO,
  DEFAULT_COLOR,
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  PRESET_COLORS,
  type ActiveTool,
  type ToolKind,
} from "./types";
import type { UseAnnotations } from "./useAnnotations";
import type { CSSProperties, Ref } from "react";

interface Props {
  tool: ActiveTool;
  setTool: (t: ActiveTool) => void;
  color: string;
  setColor: (c: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (next: number) => void;
  annotations: UseAnnotations;
  busy: string | null;
  error: string | null;
  ready: boolean; // 底图就绪，未就绪时禁用导出
  onCopy: () => void;
  onSave: () => void;
  onOcr: () => void;
  onPin: () => void;
  onCancel: () => void;
  toolbarRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  /** 工具栏被翻到选区上方（下方放不下）：决定二级面板与 tooltip 向上还是向下弹（见 .ss-toolbar-above） */
  above?: boolean;
}

const TOOLS: { kind: ActiveTool; icon: Parameters<typeof Icon>[0]["name"]; label: string }[] = [
  { kind: "move", icon: "Move", label: "移动" },
  { kind: "rect", icon: "Square", label: "矩形" },
  { kind: "arrow", icon: "ArrowUpRight", label: "箭头" },
  { kind: "brush", icon: "Pencil", label: "画笔" },
  { kind: "text", icon: "Type", label: "文字" },
  { kind: "number", icon: "Hash", label: "序号" },
  { kind: "mosaic", icon: "Grid3x3", label: "马赛克" },
];

/**
 * 支持「自动配色（auto）」的工具：只有文字与序号会按底色采样反色（见 render.ts 的
 * resolveColor）。描边类工具（矩形/箭头/画笔）遇到 auto 会 fallback 成默认色，
 * 因此不为它们展示这个无意义的选项。
 */
const AUTO_COLOR_TOOLS: ReadonlySet<ToolKind> = new Set(["text", "number"]);

/** 圆点直径随线宽变化：细线不至于看不见（下限 6），粗线不至于撑爆控件（上限 22）。 */
function strokeDotSize(strokeWidth: number): number {
  return Math.min(22, Math.max(6, strokeWidth + 5));
}

function AnnotationToolbar(props: Props) {
  const {
    tool,
    setTool,
    color,
    setColor,
    strokeWidth,
    onStrokeWidthChange,
    annotations,
    busy,
    error,
    ready,
    onCopy,
    onSave,
    onOcr,
    onPin,
    onCancel,
    toolbarRef,
    style,
    above = false,
  } = props;
  const { undo, redo, canUndo, canRedo } = annotations;

  // 滚轮与方向键都只按方向步进 ±1（不按 deltaY 大小），避免触控板惯性一下跳很多格
  const stepWidth = (delta: number) => onStrokeWidthChange(clampStrokeWidth(strokeWidth + delta));

  return (
    <div
      className={`ss-toolbar-wrap${above ? " ss-toolbar-above" : ""}`}
      ref={toolbarRef}
      style={style}
    >
      {error && <div className="ss-error">{error}</div>}
      <div className="ss-toolbar ss-annotate-toolbar">
        {/* 工具组：每个绘图工具的颜色/粗细作为它的「二级面板」挂在自己的按钮下，
            各工具各自记忆设置，互不影响。 */}
        {TOOLS.map((t) => {
          const kind = t.kind;
          const active = tool === kind;
          const showStylePanel = active && kind !== "move";
          return (
            <div className="ss-tool-group" key={kind}>
              <button
                className={`ss-btn ss-tool ${active ? "ss-tool-active" : ""}`}
                onClick={() => setTool(kind)}
                data-tooltip={t.label}
                aria-label={t.label}
                disabled={!!busy}
              >
                <Icon name={t.icon} size={16} />
              </button>

              {showStylePanel && (
                <div className="ss-tool-subpanel" role="group" aria-label={`${t.label}设置`}>
                  {/* 颜色 */}
                  <div className="ss-color-swatches">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c}
                        className={`ss-color-swatch ${color === c ? "active" : ""}`}
                        style={{ background: c }}
                        onClick={() => setColor(c)}
                        title={c}
                        aria-label={`颜色 ${c}`}
                        disabled={!!busy}
                      />
                    ))}
                    {AUTO_COLOR_TOOLS.has(kind) && (
                      <button
                        className={`ss-color-swatch ss-color-auto ${color === COLOR_AUTO ? "active" : ""}`}
                        onClick={() => setColor(COLOR_AUTO)}
                        disabled={!!busy}
                        title="自动"
                        aria-label="自动配色"
                      >
                        A
                      </button>
                    )}
                    <label className="ss-color-custom" title="自定义颜色" aria-label="自定义颜色">
                      <input
                        className="ss-color-custom-input"
                        type="color"
                        value={color === COLOR_AUTO ? DEFAULT_COLOR : color}
                        onChange={(event) => setColor(event.target.value)}
                        disabled={!!busy}
                        aria-label="自定义颜色"
                      />
                      <span
                        className={`ss-color-swatch ss-color-custom-swatch ${
                          color !== COLOR_AUTO && !PRESET_COLORS.includes(color) ? "active" : ""
                        }`}
                        style={{ background: color === COLOR_AUTO ? DEFAULT_COLOR : color }}
                        aria-hidden="true"
                      />
                    </label>
                  </div>

                  <span className="ss-sep" />

                  {/* 线宽：圆点 + 数值；悬停其上滚轮（或方向键）调节 */}
                  <div
                    className="ss-width-dot"
                    role="spinbutton"
                    tabIndex={0}
                    aria-label="线宽"
                    aria-valuemin={MIN_STROKE_WIDTH}
                    aria-valuemax={MAX_STROKE_WIDTH}
                    aria-valuenow={strokeWidth}
                    aria-disabled={!!busy}
                    title="滚轮调节线宽"
                    onWheel={(event) => {
                      if (busy) return;
                      // 只认纵向滚动：触控板横向滑动（deltaY=0）不该改线宽
                      if (event.deltaY === 0) return;
                      event.preventDefault();
                      stepWidth(event.deltaY < 0 ? 1 : -1);
                    }}
                    onKeyDown={(event) => {
                      if (busy) return;
                      if (event.key === "ArrowUp" || event.key === "ArrowRight") {
                        event.preventDefault();
                        stepWidth(1);
                      } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
                        event.preventDefault();
                        stepWidth(-1);
                      }
                    }}
                  >
                    <span
                      className="ss-width-dot-marker"
                      style={{
                        width: strokeDotSize(strokeWidth),
                        height: strokeDotSize(strokeWidth),
                      }}
                    />
                    <span className="ss-width-dot-value">{strokeWidth}px</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <span className="ss-sep" />

        {/* 撤销/重做 */}
        <button
          className="ss-btn"
          onClick={undo}
          disabled={!canUndo || !!busy}
          data-tooltip="撤销 (Ctrl+Z)"
          aria-label="撤销"
        >
          <Icon name="Undo2" size={16} />
        </button>
        <button
          className="ss-btn"
          onClick={redo}
          disabled={!canRedo || !!busy}
          data-tooltip="重做 (Ctrl+Y)"
          aria-label="重做"
        >
          <Icon name="Redo2" size={16} />
        </button>

        <span className="ss-sep" />

        {/* 导出 */}
        <button
          className="ss-btn"
          onClick={onPin}
          disabled={!!busy || !ready}
          data-tooltip="钉到桌面"
          aria-label="钉到桌面"
        >
          <Icon name="Pin" size={16} />
        </button>
        <button
          className="ss-btn"
          onClick={onSave}
          disabled={!!busy || !ready}
          data-tooltip="保存"
          aria-label="保存"
        >
          <Icon name="Download" size={16} />
        </button>
        <button
          className="ss-btn"
          onClick={onOcr}
          disabled={!!busy}
          data-tooltip="OCR"
          aria-label="OCR"
        >
          <Icon name="Search" size={16} />
        </button>
        <button
          className="ss-btn"
          onClick={onCopy}
          disabled={!!busy || !ready}
          data-tooltip="复制"
          aria-label="复制"
        >
          <Icon name="Copy" size={16} />
        </button>
        <button
          className="ss-btn ss-btn-danger"
          onClick={onCancel}
          disabled={!!busy}
          data-tooltip="取消"
          aria-label="取消"
        >
          <Icon name="X" size={16} />
        </button>
        {busy && <span className="ss-busy">{busy}…</span>}
      </div>
    </div>
  );
}

export default AnnotationToolbar;
