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
  ListOrdered,
  Binary,
  QrCode,
  Download,
  Camera,
  Pin,
  Redo2,
  Square,
  ArrowUpRight,
  Pencil,
  Type,
  Grid3x3,
  Hash,
  Palette,
  RemoveFormatting,
  Calculator,
  Volume2,
  Play,
  Pause,
  Mic,
  MicOff,
  Activity,
  AlertCircle,
  Video,
  Film,
  Monitor,
  AppWindow,
  FolderOpen,
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
  ListOrdered,
  Binary,
  QrCode,
  Download,
  Camera,
  Pin,
  Redo2,
  Square,
  ArrowUpRight,
  Pencil,
  Type,
  Grid3x3,
  Hash,
  Palette,
  RemoveFormatting,
  Calculator,
  Volume2,
  Play,
  Pause,
  Mic,
  MicOff,
  Activity,
  AlertCircle,
  Video,
  Film,
  Monitor,
  AppWindow,
  FolderOpen,
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
