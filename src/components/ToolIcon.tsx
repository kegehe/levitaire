import type { CSSProperties } from "react";

/** 工具图标名 — 与 registry.ts 中 tool.icon 对应 */
export type ToolIconName =
  | "Sparkles"
  | "Camera"
  | "Mic"
  | "Activity"
  | "Video"
  | "X"
  | "Rocket"
  | "Compass"
  | "Timer";

interface ToolIconProps {
  name: ToolIconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * 手绘 SVG 工具图标，统一 24x24 viewBox，stroke="currentColor" 风格。
 * 不依赖 lucide-react，颜色随父级 currentColor 继承。
 */
function ToolIcon({ name, size = 20, className = "", style }: ToolIconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: `tool-icon ${className}`.trim(),
    style,
    xmlns: "http://www.w3.org/2000/svg",
  };

  switch (name) {
    // 文字工具栏 — 文档 + 闪烁星标（AI 优化）
    case "Sparkles":
      return (
        <svg {...common}>
          <path d="M5 3.5h8.5L17 7v13.5H5z" />
          <path d="M13 3.5V7h4" />
          <path d="M8 12h6M8 15.5h6M8 9h2" />
          <path d="M18.5 4.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
        </svg>
      );

    // 屏幕截图 — 相机框 + 取景十字
    case "Camera":
      return (
        <svg {...common}>
          <path d="M4 8.5h3l1.2-2h7.6L17 8.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
          <circle cx="12" cy="14" r="3.2" />
          <path d="M12 9.4v1.2M12 17.4v1.2M7.4 14h1.2M15.4 14h1.2" />
        </svg>
      );

    // 语音输入 — 麦克风
    case "Mic":
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M6 11a6 6 0 0 0 12 0" />
          <path d="M12 17v3.5M9 20.5h6" />
        </svg>
      );

    // 系统监控 — 心电图波形
    case "Activity":
      return (
        <svg {...common}>
          <path d="M3 12h4l2-6 4 12 2-6h6" />
        </svg>
      );

    // GIF/录屏 — 摄像机 + 胶片
    case "Video":
      return (
        <svg {...common}>
          <rect x="3" y="6.5" width="13" height="11" rx="2" />
          <path d="M16 10l5-3v10l-5-3" />
          <path d="M7 10v4M9.5 10v4M12 10v4" />
        </svg>
      );

    // 关闭
    case "X":
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );

    // 自启动 — 火箭
    case "Rocket":
      return (
        <svg {...common}>
          <path d="M9 15c-2 0-4 1-4 4 2 0 3-.5 4-1.5" />
          <path d="M9 15c-.5-1.5-.5-3 0-4.5C10 8 12 5 16 4c.5 4-1.5 6-3.5 7.5-1.5.5-3 .5-4.5 0z" />
          <circle cx="13" cy="9" r="1.3" />
        </svg>
      );

    // 快速输入转盘 — 罗盘
    case "Compass":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M15.5 8.5l-2 5-5 2 2-5z" />
          <circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      );

    // 番茄钟 — 番茄（主体圆 + 顶部叶瓣 + 蒂）
    case "Timer":
      return (
        <svg {...common}>
          <circle cx="12" cy="13.5" r="6.5" />
          <path d="M12 7.5c-1.2-2.6-3.4-3.4-4.8-2.7 1 .5 1.6 1.5 1.8 2.9" />
          <path d="M12 7.5c1.2-2.6 3.4-3.4 4.8-2.7-1 .5-1.6 1.5-1.8 2.9" />
          <path d="M12 7.5V5" />
        </svg>
      );

    default:
      return null;
  }
}

export default ToolIcon;
