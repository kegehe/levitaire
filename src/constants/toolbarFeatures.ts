import type { IconName } from "../components/Icon";
import { invoke } from "@tauri-apps/api/core";
import { decodeSelection, encodeSelection } from "./selectionPersistence";

/** 悬浮工具栏功能定义 */
export interface ToolbarFeature {
  id: string;
  icon: IconName;
  label: string;
}

/** 工具栏默认功能列表 */
export const TOOLBAR_FEATURES: ToolbarFeature[] = [
  { id: "copy", icon: "Copy", label: "复制" },
  { id: "search", icon: "Search", label: "搜索" },
  { id: "translate", icon: "Globe", label: "翻译" },
  { id: "optimize", icon: "Sparkles", label: "优化" },
  { id: "uppercase", icon: "CaseUpper", label: "大写" },
  { id: "lowercase", icon: "CaseLower", label: "小写" },
  { id: "dedup", icon: "ListFilter", label: "去重" },
  { id: "numbering", icon: "ListOrdered", label: "编号" },
  { id: "base64-encode", icon: "Binary", label: "Base64 编码" },
  { id: "base64-decode", icon: "Binary", label: "Base64 解码" },
  { id: "unicode-encode", icon: "Type", label: "中文转 Unicode" },
  { id: "unicode-decode", icon: "Type", label: "Unicode 转中文" },
  { id: "to-traditional", icon: "Languages", label: "简体转繁体" },
  { id: "to-simplified", icon: "Languages", label: "繁体转简体" },
  { id: "md5-encrypt", icon: "Hash", label: "MD5 加密" },
  { id: "qrcode", icon: "QrCode", label: "二维码" },
  { id: "clear", icon: "RemoveFormatting", label: "清除" },
  { id: "char-count", icon: "Calculator", label: "字符统计" },
  { id: "tts", icon: "Volume2", label: "朗读" },
];

/** 全部功能 ID（默认全部启用） */
export const DEFAULT_FEATURE_IDS: string[] = TOOLBAR_FEATURES.map((f) => f.id);

/**
 * 工具栏默认按钮顺序。
 *
 * 与 TOOLBAR_FEATURES 的注册顺序不同——历史上工具栏按 JSX 硬编码顺序渲染，
 * 其中 qrcode、clear、char-count、tts 的位置与注册顺序有差异。单独维护该数组，
 * 使未自定义顺序的用户在升级后按钮排列保持不变。
 */
export const DEFAULT_FEATURE_ORDER: string[] = [
  "copy",
  "search",
  "translate",
  "optimize",
  "uppercase",
  "lowercase",
  "dedup",
  "numbering",
  "qrcode",
  "base64-encode",
  "base64-decode",
  "unicode-encode",
  "unicode-decode",
  "to-traditional",
  "to-simplified",
  "md5-encrypt",
  "char-count",
  "tts",
  "clear",
];

/**
 * 从后端配置加载启用的功能 ID 列表。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 * - 从未设置过（空列表）→ 默认全量；
 * - 用户主动全部取消勾选（存的是哨兵）→ 空列表，**不再被当成"从未设置"**；
 * - 含已移除的旧 ID → 结构已变，重置为默认全量；
 * - 否则原样返回，尊重用户已禁用的功能。
 */
export async function fetchEnabledFeatures(): Promise<string[]> {
  const allIds = DEFAULT_FEATURE_IDS;
  try {
    const stored = await invoke<string[]>("get_toolbar_features");
    const selected = decodeSelection(stored);
    if (selected === null) {
      return [...allIds];
    }
    if (selected.length === 0) {
      // 用户把每一项都关掉了：这是有效状态，别回退默认（否则永远关不掉）
      return [];
    }
    const allIdSet = new Set(allIds);
    // 含已移除的旧 ID：结构已变，重置为默认全量
    if (selected.some((id) => !allIdSet.has(id))) {
      await invoke("set_toolbar_features", { features: allIds });
      return [...allIds];
    }
    // 原样返回。不自动追加新增功能——否则用户主动取消勾选的项
    // 会被当作"新增功能"在下次启动时补回，造成"重启回到全选"的假象。
    return selected;
  } catch {
    return [...allIds];
  }
}

/** 保存启用的工具栏功能 ID 列表到后端配置（空选会编码成哨兵，见 selectionPersistence） */
export async function saveEnabledFeatures(ids: string[]): Promise<void> {
  await invoke("set_toolbar_features", { features: encodeSelection(ids) });
}

/**
 * 从后端配置加载工具栏按钮顺序（全量功能 ID 的有序列表）。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 * - 空列表/读取失败：回退为默认顺序；
 * - 含已移除的旧 ID / 重复 ID：剔除无效项并去重；
 * - 缺新版本新增功能：按默认顺序追加到末尾。
 * 合并结果只返回不写回——持久化仅在用户真正拖拽排序时发生（saveToolbarFeatureOrder），
 * 避免读取阶段写入导致其它已打开的旧状态窗口用旧列表覆盖新配置。
 */
export async function fetchToolbarFeatureOrder(): Promise<string[]> {
  const defaults = DEFAULT_FEATURE_ORDER;
  try {
    const stored = await invoke<string[]>("get_toolbar_feature_order");
    if (!stored || stored.length === 0) {
      return [...defaults];
    }
    const knownIds = new Set(defaults);
    // 保留用户顺序中仍有效且首次出现的项（剔除已移除旧 ID 与重复 ID）
    const kept = stored.filter((id, index) => knownIds.has(id) && stored.indexOf(id) === index);
    // 新版本新增功能按默认顺序追加到末尾，避免新按钮在工具栏里没有入口
    return [...kept, ...defaults.filter((id) => !kept.includes(id))];
  } catch {
    return [...defaults];
  }
}

/** 保存工具栏按钮顺序到后端配置 */
export async function saveToolbarFeatureOrder(order: string[]): Promise<void> {
  await invoke("set_toolbar_feature_order", { order });
}
