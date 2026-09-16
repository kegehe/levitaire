import Icon from "../../../components/Icon";
import {
  COLOR_AUTO,
  DEFAULT_COLOR,
  PRESET_COLORS,
  STROKE_WIDTHS,
  type ActiveTool,
} from "./types";
import type { UseAnnotations } from "./useAnnotations";
import type { CSSProperties, Ref } from "react";

interface Props {
  tool: ActiveTool;
  setTool: (t: ActiveTool) => void;
  color: string;
  setColor: (c: string) => void;
  widthIndex: number;
  setWidthIndex: (i: number) => void;
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
  /** 工具栏被翻到选区上方（下方放不下）：决定 tooltip 向上还是向下弹（见 .ss-toolbar-above） */
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

function AnnotationToolbar(props: Props) {
  const {
    tool,
    setTool,
    color,
    setColor,
    widthIndex,
    setWidthIndex,
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

  return (
    <div
      className={`ss-toolbar-wrap${above ? " ss-toolbar-above" : ""}`}
      ref={toolbarRef}
      style={style}
    >
      {error && <div className="ss-error">{error}</div>}
      <div className="ss-toolbar ss-annotate-toolbar">
        {/* 工具组 */}
        {TOOLS.map((t) => (
          <button
            key={t.kind}
            className={`ss-btn ss-tool ${tool === t.kind ? "ss-tool-active" : ""}`}
            onClick={() => setTool(t.kind)}
            data-tooltip={t.label}
            aria-label={t.label}
            disabled={!!busy}
          >
            <Icon name={t.icon} size={16} />
          </button>
        ))}

        <span className="ss-sep" />

        {/* 颜色 */}
        <div className="ss-color">
          <button
            className="ss-color-btn"
            title="颜色"
            disabled={!!busy}
            style={{ background: color === COLOR_AUTO ? "transparent" : color }}
          />
          <div className="ss-color-pop">
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
            <button
              className={`ss-color-swatch ss-color-auto ${color === COLOR_AUTO ? "active" : ""}`}
              onClick={() => setColor(COLOR_AUTO)}
              disabled={!!busy}
              title="自动"
            >
              A
            </button>
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
        </div>

        {/* 粗细 */}
        <div className="ss-width">
          {STROKE_WIDTHS.map((w, i) => (
            <button
              key={i}
              className={`ss-width-btn ${widthIndex === i ? "ss-width-btn-active" : ""}`}
              onClick={() => setWidthIndex(i)}
              title={`${w}px`}
              disabled={!!busy}
            >
              <span className="ss-width-line" style={{ height: `${w}px` }} />
            </button>
          ))}
        </div>

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
