import {
  Copy,
  Sparkles,
  ArrowLeft,
  X,
  Check,
  Settings,
  Undo2,
  Loader2,
  Eye,
  EyeOff,
  GraduationCap,
  Scissors,
  Globe,
  Search,
  GripVertical,
  CaseUpper,
  CaseLower,
  Image,
  ListFilter,
  Binary,
  QrCode,
  Download,
} from "lucide-react";
import type { LucideProps } from "lucide-react";

const ICON_MAP = {
  Copy,
  Sparkles,
  ArrowLeft,
  X,
  Check,
  Settings,
  Undo2,
  Loader2,
  Eye,
  EyeOff,
  GraduationCap,
  Scissors,
  Globe,
  Search,
  GripVertical,
  CaseUpper,
  CaseLower,
  Image,
  ListFilter,
  Binary,
  QrCode,
  Download,
} as const;

export type IconName = keyof typeof ICON_MAP;

interface IconProps extends Omit<LucideProps, "ref"> {
  name: IconName;
  size?: number;
}

function Icon({ name, size = 16, className = "", ...rest }: IconProps) {
  const LucideIcon = ICON_MAP[name];
  return (
    <LucideIcon
      size={size}
      className={`icon ${className}`.trim()}
      strokeWidth={2}
      {...rest}
    />
  );
}

export default Icon;
