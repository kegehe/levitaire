import type { IconName } from "../components/Icon";

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
  { id: "base64-encode", icon: "Binary", label: "Base64 编码" },
  { id: "base64-decode", icon: "Binary", label: "Base64 解码" },
  { id: "qrcode", icon: "QrCode", label: "二维码" },
];

const STORAGE_KEY = "floast-toolbar-features";

/** 获取启用的工具栏功能 ID 列表（默认全部启用） */
export function getEnabledFeatures(): string[] {
  const allIds = TOOLBAR_FEATURES.map((f) => f.id);
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed: string[] = JSON.parse(stored);
      // 检测是否有功能被移除（旧版残留 ID）
      const allIdSet = new Set(allIds);
      const hasRemoved = parsed.some((id) => !allIdSet.has(id));
      if (hasRemoved) {
        // 有残留 ID，说明功能列表结构已变，重置为当前默认
        setEnabledFeatures(allIds);
        return allIds;
      }
      // 追加新功能：只补全当前功能列表中存在但存储中没有的 ID
      // 用户之前从未见过这些功能，不应算作"主动禁用"
      const newIds = allIds.filter((id) => !parsed.includes(id));
      if (newIds.length > 0) {
        const merged = [...parsed, ...newIds];
        setEnabledFeatures(merged);
        return merged;
      }
      return parsed;
    } catch {
      // fallthrough
    }
  }
  return allIds;
}

/** 保存启用的工具栏功能 ID 列表 */
export function setEnabledFeatures(ids: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}
