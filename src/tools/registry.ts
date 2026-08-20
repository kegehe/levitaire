import type { ComponentType } from "react";
import type { ToolIconName } from "../components/ToolIcon";

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
  icon: ToolIconName;
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
    id: "pomodoro",
    name: "番茄钟",
    icon: "Timer",
    description: "常驻悬浮倒计时，专注/休息自动循环，到点 TTS 提示音提醒",
    category: "system",
    defaultEnabled: false,
    loader: () => import("./pomodoro/PomodoroTool"),
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
  {
    id: "quick-input",
    name: "快速输入",
    icon: "Compass",
    description: "点击触发键唤起转盘，鼠标旋转选择预设词或剪贴板历史，点击选中即输入",
    category: "text",
    defaultEnabled: false,
    loader: () => import("./quick-input/QuickInputTool"),
    activation: "immediate",
  },
];

/** 类别显示名 */
export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  text: "文字工具",
  screen: "屏幕工具",
  system: "系统工具",
};

const STORAGE_KEY = "levitaire-tools-enabled";
// 旧版 STORAGE_KEY：存的就是工具 ID 列表，语义与当前一致，可作为真值直接迁移。
// 覆盖 Floatory / Floast 两代产品的启停配置。
const LEGACY_STORAGE_KEYS = ["floatory-tools-enabled", "floast-tools-enabled"];
// 更早的 toolbar-features key：存的是文字工具栏内部功能 ID（copy/search/...），
// 与工具级开关语义不同，迁移时只能按 defaultEnabled 初始化。
const LEGACY_FEATURE_KEYS = ["floatory-toolbar-features", "floast-toolbar-features"];

/** 工具启用状态的后端 getter 命令映射。
 * 用于前端与后端 config.json 真值同步（ToolPalette 启用开关、FloatingOrb 自启动）。
 * 新增工具时在此登记一项即可，调用方自动生效。 */
export const BACKEND_TOOLS: ReadonlyArray<{ id: string; getter: string }> = [
  { id: "text-toolbar", getter: "get_text_toolbar_enabled" },
  { id: "screenshot", getter: "get_screenshot_enabled" },
  { id: "system-monitor", getter: "get_system_monitor_enabled" },
  { id: "pomodoro", getter: "get_pomodoro_enabled" },
  { id: "recording", getter: "get_recording_enabled" },
  { id: "quick-input", getter: "get_quick_input_enabled" },
];

/** 获取启用的工具 ID 列表 */
export function getEnabledTools(): string[] {
  const allIdSet = new Set(FLOATING_TOOLS.map((t) => t.id));
  const defaults = FLOATING_TOOLS.filter((t) => t.defaultEnabled).map((t) => t.id);

  // 1) 当前 key
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed = parseEnabledTools(stored, allIdSet);
    // 解析成功即时返回（损坏则回退 defaults 并写回）；若过滤掉了残留 ID 需写回过滤结果
    const result = parsed ?? defaults;
    if (parsed === null || parsed.length !== countParsed(stored)) {
      setEnabledTools(result);
    }
    return result;
  }

  // 2) 旧版迁移链：优先迁移旧版 STORAGE_KEY（floatory/floast-tools-enabled），
  //    其内容就是工具 ID 列表，语义一致，作为真值迁入当前 key。
  //    某代 key 不存在或已损坏时继续尝试更早一代，避免吞掉用户真实数据。
  for (const legacy of LEGACY_STORAGE_KEYS) {
    const legacyVal = localStorage.getItem(legacy);
    if (legacyVal) {
      const ids = parseEnabledTools(legacyVal, allIdSet);
      if (ids) {
        setEnabledTools(ids);
        return ids;
      }
      // 内容损坏则跳过，尝试更早一代
    }
  }

  // 3) 更早的 toolbar-features key（存的是工具栏内部功能 ID copy/search/...），
  //    语义与工具级开关不同，只能按 defaultEnabled 初始化。
  if (LEGACY_FEATURE_KEYS.some((k) => localStorage.getItem(k))) {
    setEnabledTools(defaults);
    return defaults;
  }

  // 首次使用：启用所有 defaultEnabled 为 true 的工具
  setEnabledTools(defaults);
  return defaults;
}

/** 解析存储的 JSON 工具 ID 列表，过滤掉已移除工具的残留 ID，保留有效项。
 * 返回 null 表示内容损坏/非数组（调用方可回退 defaults 或跳过该 key）。 */
function parseEnabledTools(raw: string, allIdSet: Set<string>): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => allIdSet.has(id as string));
  } catch {
    return null;
  }
}

/** 计算原始 JSON 数组的元素个数，用于判断过滤后是否需要写回。 */
function countParsed(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** 保存启用的工具 ID 列表 */
export function setEnabledTools(ids: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}
