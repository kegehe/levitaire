import type { IconName } from "../components/Icon";
import { invoke } from "@tauri-apps/api/core";

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
  { id: "md5-encrypt", icon: "Hash", label: "MD5 加密" },
  { id: "qrcode", icon: "QrCode", label: "二维码" },
  { id: "clear", icon: "RemoveFormatting", label: "清除" },
  { id: "char-count", icon: "Calculator", label: "字符统计" },
  { id: "tts", icon: "Volume2", label: "朗读" },
];

/** 全部功能 ID（默认全部启用） */
export const DEFAULT_FEATURE_IDS: string[] = TOOLBAR_FEATURES.map((f) => f.id);

/**
 * 从后端配置加载启用的功能 ID 列表。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 * 空列表或含未知 ID 时回退为默认全量；否则原样返回，尊重用户已禁用的功能。
 */
export async function fetchEnabledFeatures(): Promise<string[]> {
  const allIds = DEFAULT_FEATURE_IDS;
  try {
    const stored = await invoke<string[]>("get_toolbar_features");
    if (!stored || stored.length === 0) {
      return [...allIds];
    }
    const allIdSet = new Set(allIds);
    // 含已移除的旧 ID：结构已变，重置为默认全量
    if (stored.some((id) => !allIdSet.has(id))) {
      await invoke("set_toolbar_features", { features: allIds });
      return [...allIds];
    }
    // 原样返回。不自动追加新增功能——否则用户主动取消勾选的项
    // 会被当作"新增功能"在下次启动时补回，造成"重启回到全选"的假象。
    return stored;
  } catch {
    return [...allIds];
  }
}

/** 保存启用的工具栏功能 ID 列表到后端配置 */
export async function saveEnabledFeatures(ids: string[]): Promise<void> {
  await invoke("set_toolbar_features", { features: ids });
}
