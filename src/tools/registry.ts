import type { ComponentType } from "react";
import type { IconName } from "../components/Icon";

/** 悬浮工具类别 */
export type ToolCategory = "text" | "screen" | "system";

/** 工具激活方式：
 * - selection: 激活后等待用户选中文字，由后端 selection-found 事件触发显示
 * - immediate: 选中后立即执行工具流程（如进入截图模式）
 */
export type ToolActivation = "selection" | "immediate";

/** 工具组件 props */
export interface ToolProps {
  [key: string]: unknown;
}

/** 悬浮工具定义 */
export interface FloatingTool {
  id: string;
  name: string;
  icon: IconName;
  description: string;
  category: ToolCategory;
  /** 默认是否启用 */
  defaultEnabled: boolean;
  /** 懒加载入口，Vite 会将其分割为独立 chunk */
  loader: () => Promise<{ default: ComponentType<ToolProps> }>;
  activation: ToolActivation;
}

/**
 * 悬浮工具注册表。
 * 新增工具时在此登记一项，卡片选择器会自动展示。
 */
export const FLOATING_TOOLS: FloatingTool[] = [
  {
    id: "text-toolbar",
    name: "文字工具栏",
    icon: "Sparkles",
    description: "选中文字后弹出复制、翻译、AI 优化、二维码等快捷操作",
    category: "text",
    defaultEnabled: true,
    loader: () => import("./text-toolbar/TextToolbar"),
    activation: "selection",
  },
  {
    id: "screenshot",
    name: "屏幕截图",
    icon: "Camera",
    description: "拖框截取屏幕区域，可复制、保存、OCR 识别或钉在桌面",
    category: "screen",
    defaultEnabled: true,
    loader: () => import("./screenshot/ScreenshotTool"),
    activation: "immediate",
  },
  {
    id: "voice-input",
    name: "语音输入",
    icon: "Mic",
    description: "录音并识别为文字，自动粘贴到当前焦点窗口",
    category: "system",
    defaultEnabled: false,
    loader: () => import("./voice-input/VoiceInput"),
    activation: "immediate",
  },
  {
    id: "system-monitor",
    name: "系统监控",
    icon: "Activity",
    description: "常驻悬浮显示 CPU、内存、网络、磁盘、电池实时状态曲线",
    category: "system",
    defaultEnabled: false,
    loader: () => import("./system-monitor/SystemMonitor"),
    activation: "immediate",
  },
  {
    id: "recording",
    name: "GIF/录屏",
    icon: "Video",
    description: "录制屏幕为 GIF 动图或 MP4 视频，支持全屏/区域/窗口识别",
    category: "screen",
    defaultEnabled: false,
    loader: () => import("./recording/RecordingTool"),
    activation: "immediate",
  },
];

/** 类别显示名 */
export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  text: "文字工具",
  screen: "屏幕工具",
  system: "系统工具",
};

const STORAGE_KEY = "floatory-tools-enabled";
const AUTOSTART_KEY = "floatory-tools-autostart";
const LEGACY_KEY = "floatory-toolbar-features";

/** 工具启用状态的后端 getter 命令映射。
 * 用于前端与后端 config.json 真值同步（ToolPalette、FloatingOrb 自启动）。
 * 新增工具时在此登记一项即可，两处调用方自动生效。 */
export const BACKEND_TOOLS: ReadonlyArray<{ id: string; getter: string }> = [
  { id: "text-toolbar", getter: "get_text_toolbar_enabled" },
  { id: "screenshot", getter: "get_screenshot_enabled" },
  { id: "voice-input", getter: "get_stt_enabled" },
  { id: "system-monitor", getter: "get_system_monitor_enabled" },
  { id: "recording", getter: "get_recording_enabled" },
];

/** 获取启用的工具 ID 列表 */
export function getEnabledTools(): string[] {
  const allIdSet = new Set(FLOATING_TOOLS.map((t) => t.id));
  const defaults = FLOATING_TOOLS.filter((t) => t.defaultEnabled).map((t) => t.id);
  const stored = localStorage.getItem(STORAGE_KEY);

  // 旧版迁移：原 floatory-toolbar-features 存的是文字工具栏内部功能 ID（copy/search/...）
  // 与工具级开关语义不同，迁移时按 defaultEnabled 初始化
  if (!stored && localStorage.getItem(LEGACY_KEY)) {
    setEnabledTools(defaults);
    return defaults;
  }

  if (stored) {
    try {
      const parsed: string[] = JSON.parse(stored);
      // 过滤掉已移除工具的残留 ID，保留其余有效项（不丢失用户自定义）。
      // 不自动补全 defaultEnabled 工具——否则用户主动禁用的工具会被当作"新增"补回，
      // 与后端真值（config.text_toolbar_enabled / screenshot_enabled）冲突。
      // text-toolbar / screenshot 的真值由 ToolPalette 挂载时从后端同步覆盖。
      const valid = parsed.filter((id) => allIdSet.has(id));
      if (valid.length !== parsed.length) {
        setEnabledTools(valid);
      }
      return valid;
    } catch {
      // fallthrough
    }
  }
  // 首次使用：启用所有 defaultEnabled 为 true 的工具
  setEnabledTools(defaults);
  return defaults;
}

/** 保存启用的工具 ID 列表 */
export function setEnabledTools(ids: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

/** 获取自启动工具 ID 列表（应用启动时自动打开窗口的工具） */
export function getAutostartTools(): string[] {
  const allIdSet = new Set(FLOATING_TOOLS.map((t) => t.id));
  const stored = localStorage.getItem(AUTOSTART_KEY);
  if (stored) {
    try {
      const parsed: string[] = JSON.parse(stored);
      // 过滤掉已移除工具的残留 ID
      const valid = parsed.filter((id) => allIdSet.has(id));
      if (valid.length !== parsed.length) {
        setAutostartTools(valid);
      }
      return valid;
    } catch {
      // fallthrough
    }
  }
  return [];
}

/** 保存自启动工具 ID 列表 */
export function setAutostartTools(ids: string[]): void {
  localStorage.setItem(AUTOSTART_KEY, JSON.stringify(ids));
}

/** 切换某个工具的自启动状态，返回切换后的值 */
export function toggleAutostart(id: string): boolean {
  const current = getAutostartTools();
  const has = current.includes(id);
  const next = has ? current.filter((x) => x !== id) : [...current, id];
  setAutostartTools(next);
  return !has;
}
