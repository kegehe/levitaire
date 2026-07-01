import type { ReactNode } from "react";
import type { IconName } from "./Icon";
import Icon from "./Icon";
import "./ToolbarButton.css";

interface ToolbarButtonProps {
  /** 图标：IconName 字符串或自定义 ReactNode */
  icon: IconName | ReactNode;
  /** 无障碍标签 */
  label: string;
  /** 点击回调 */
  onClick: () => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否显示加载动画 */
  loading?: boolean;
  /** 按钮变体 */
  variant?: "ghost" | "primary" | "danger";
  /** 按钮尺寸 */
  size?: "sm" | "md";
}

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled = false,
  loading = false,
  variant = "ghost",
  size = "md",
}: ToolbarButtonProps) {
  const className = [
    "toolbar-button",
    `toolbar-button--${variant}`,
    `toolbar-button--${size}`,
    loading ? "toolbar-button--loading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const iconContent = loading ? (
    <Icon name="Loader2" size={size === "sm" ? 14 : 16} />
  ) : typeof icon === "string" ? (
    <Icon name={icon as IconName} size={size === "sm" ? 14 : 16} />
  ) : (
    icon
  );

  return (
    <button
      className={className}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      <span className="toolbar-button-icon">{iconContent}</span>
    </button>
  );
}

export default ToolbarButton;
