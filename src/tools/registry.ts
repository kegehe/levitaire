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
    id: "utility-hub",
    name: "通用工具",
    icon: "Grid3x3",
    description: "内置取色器、滚动导航与窗口置顶：拾取屏幕颜色、精确翻页长文档、把任意窗口钉在最前",
    category: "screen",
    defaultEnabled: true,
    loader: () => import("./utility-hub/UtilityHub"),
    activation: "immediate",
  },
  {
    id: "todo",
    name: "待办清单",
    icon: "ListTodo",
    description: "快速添加任务、设置截止时间和提醒，随时查看完成进度",
    category: "system",
    defaultEnabled: false,
    loader: () => import("./todo/TodoTool"),
    activation: "immediate",
  },
  {
    id: "sketch",
    name: "屏幕草稿",
    icon: "Pencil",
    description: "在当前屏幕上绘制临时草图，支持保存为透明 PNG",
    category: "screen",
    defaultEnabled: true,
    loader: () => import("./sketch/SketchTool"),
    activation: "immediate",
  },
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
    id: "timer",
    name: "时间工具",
    icon: "Clock",
    description: "时钟、倒计时、番茄钟、秒表与月历，支持农历日期、专注循环和分段计时",
    category: "system",
    defaultEnabled: false,
    loader: () => import("./timer/TimerTool"),
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
  {
    id: "sticky-notes",
    name: "便利贴",
    icon: "StickyNote",
    description: "在桌面各处贴便利贴：新建、换色、随手记录，收起不丢失，随时从管理窗唤出",
    category: "system",
    defaultEnabled: false,
    loader: () => import("./sticky-note/StickyNoteManager"),
    activation: "immediate",
  },
  {
    id: "system-cleaner",
    name: "系统清理",
    icon: "Broom",
    description:
      "扫描并清理可安全识别的临时文件与缓存；每一项都写明后果，删不掉的绝不硬删",
    category: "system",
    defaultEnabled: false,
    loader: () => import("./system-cleaner/SystemCleanerTool"),
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

/** 工具启用状态的后端读写命令映射。
 *
 * `getter` 用于启动/获焦时把后端 config.json 的真值同步回面板；
 * `setter` 用于把面板开关（含「全部开启 / 全部关闭」）下发到后端。
 *
 * **新增工具必须在此登记一项**——漏登记不会报任何错，但该工具的开关会退化成
 * 「只改前端状态」：既不持久化，也不会在禁用时收起已打开的窗口，于是 palette 的
 * 「全部关闭」关不掉它（通用工具就曾因此漏登记，`setter` 也一并集中在这里，
 * 避免再出现「id→命令」第二张手写表与本表不同步）。 */
export const BACKEND_TOOLS: ReadonlyArray<{ id: string; getter: string; setter: string }> = [
  { id: "sketch", getter: "get_sketch_enabled", setter: "set_sketch_enabled" },
  { id: "text-toolbar", getter: "get_text_toolbar_enabled", setter: "set_text_toolbar_enabled" },
  { id: "screenshot", getter: "get_screenshot_enabled", setter: "set_screenshot_enabled" },
  {
    id: "system-monitor",
    getter: "get_system_monitor_enabled",
    setter: "set_system_monitor_enabled",
  },
  { id: "timer", getter: "get_timer_enabled", setter: "set_timer_enabled" },
  { id: "todo", getter: "get_todo_enabled", setter: "set_todo_enabled" },
  { id: "recording", getter: "get_recording_enabled", setter: "set_recording_enabled" },
  { id: "quick-input", getter: "get_quick_input_enabled", setter: "set_quick_input_enabled" },
  {
    id: "sticky-notes",
    getter: "get_sticky_notes_enabled",
    setter: "set_sticky_notes_enabled",
  },
  { id: "utility-hub", getter: "get_utility_hub_enabled", setter: "set_utility_hub_enabled" },
  {
    id: "system-cleaner",
    getter: "get_system_cleaner_enabled",
    setter: "set_system_cleaner_enabled",
  },
];

/** 取某工具的后端启用开关命令；未登记（有守卫测试兜底）时返回 undefined。 */
export function backendSetterFor(id: string): string | undefined {
  return BACKEND_TOOLS.find((tool) => tool.id === id)?.setter;
}

/**
 * 已下线工具的 ID 别名：工具被并入其他工具后，旧 ID 需要映射到宿主工具，
 * 否则存储里的启用状态与「启动时自动打开」配置会随工具下线一起丢失。
 * - pomodoro → timer：番茄钟不再是独立工具，已并入「时间工具」（time-overlay）
 */
export const TOOL_ID_ALIASES: Readonly<Record<string, string>> = {
  pomodoro: "timer",
};

/** 把可能已下线的旧工具 ID 映射为当前有效的工具 ID。 */
export function resolveToolIdAlias(id: string): string {
  return TOOL_ID_ALIASES[id] ?? id;
}

/** 读取存储中的工具 ID 数组；非数组/非法 JSON 返回 null（调用方回退 defaults 或跳过该 key）。 */
function readStoredIds(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

/** 归一化存储中的工具 ID：应用下线别名、去掉已移除工具的残留项、去重（保留首次出现顺序）。 */
function normalizeToolIds(ids: string[], allIdSet: Set<string>): string[] {
  const result: string[] = [];
  for (const id of ids) {
    const resolved = resolveToolIdAlias(id);
    if (allIdSet.has(resolved) && !result.includes(resolved)) result.push(resolved);
  }
  return result;
}

/** 判断归一化结果是否与存储原值一致（顺序敏感），不一致时需要写回。 */
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 获取启用的工具 ID 列表 */
export function getEnabledTools(): string[] {
  const allIdSet = new Set(FLOATING_TOOLS.map((t) => t.id));
  const defaults = FLOATING_TOOLS.filter((t) => t.defaultEnabled).map((t) => t.id);

  // 1) 当前 key
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const raw = readStoredIds(stored);
    // 解析成功即时返回（损坏则回退 defaults 并写回）；归一化会映射下线别名、
    // 过滤残留 ID 并去重，与存储原值不一致时写回，避免每次启动重复迁移。
    const normalized = raw ? normalizeToolIds(raw, allIdSet) : null;
    const result = normalized ?? defaults;
    if (!raw || !sameIds(raw, result)) {
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
      const ids = readStoredIds(legacyVal);
      if (ids) {
        const normalized = normalizeToolIds(ids, allIdSet);
        setEnabledTools(normalized);
        return normalized;
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

/** 保存启用的工具 ID 列表。
 *
 * 写入失败（配额耗尽 / 隐私模式）时降级为「仅本次会话生效」而不抛：读取侧
 * （`readStoredIds`）早已有同样的兜底，写入侧不设防会让 `getEnabledTools()` 的
 * 写回步骤把整个注册表初始化带崩（面板挂载即白屏）。 */
export function setEnabledTools(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch (error) {
    console.warn("[registry] 工具启用状态写入 localStorage 失败，本次仅内存生效:", error);
  }
}
