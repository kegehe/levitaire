import { invoke } from "@tauri-apps/api/core";

/** 搜索引擎 ID */
export type SearchEngineId = "bing" | "google" | "baidu" | "duckduckgo" | "sogou";

/** 默认搜索引擎：必应（保持历史行为） */
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = "bing";

const SEARCH_ENGINE_SET: ReadonlySet<SearchEngineId> = new Set([
  "bing",
  "google",
  "baidu",
  "duckduckgo",
  "sogou",
]);

/** 判定并归一化存储中的搜索引擎 ID，脏数据回退到默认值 */
export function normalizeSearchEngine(raw: unknown): SearchEngineId {
  if (typeof raw === "string" && SEARCH_ENGINE_SET.has(raw as SearchEngineId)) {
    return raw as SearchEngineId;
  }
  return DEFAULT_SEARCH_ENGINE;
}

/**
 * 从后端配置加载搜索引擎。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 */
export async function fetchSearchEngine(): Promise<SearchEngineId> {
  try {
    const stored = await invoke<string>("get_search_engine");
    if (stored) {
      return normalizeSearchEngine(stored);
    }
  } catch {
    // fallthrough
  }
  return DEFAULT_SEARCH_ENGINE;
}

/** 保存搜索引擎配置到后端 */
export async function saveSearchEngine(engine: SearchEngineId): Promise<void> {
  await invoke("set_search_engine", { engine });
}

/** 搜索引擎选项（供设置页下拉渲染） */
export const SEARCH_ENGINE_OPTIONS: ReadonlyArray<{
  value: SearchEngineId;
  label: string;
}> = [
  { value: "bing", label: "必应 Bing" },
  { value: "google", label: "Google" },
  { value: "baidu", label: "百度" },
  { value: "duckduckgo", label: "DuckDuckGo" },
  { value: "sogou", label: "搜狗" },
];

/** 各搜索引擎的搜索 URL 模板（{query} 将被替换为 URL 编码后的关键词） */
const SEARCH_URL_TEMPLATES: Record<SearchEngineId, string> = {
  bing: "https://www.bing.com/search?q={query}",
  google: "https://www.google.com/search?q={query}",
  baidu: "https://www.baidu.com/s?wd={query}",
  duckduckgo: "https://duckduckgo.com/?q={query}",
  sogou: "https://www.sogou.com/web?query={query}",
};

/** 按引擎 ID 与查询词构建搜索 URL。未知引擎回退到默认 Bing（防御） */
export function buildSearchUrl(engine: SearchEngineId, query: string): string {
  const template = SEARCH_URL_TEMPLATES[engine] ?? SEARCH_URL_TEMPLATES[DEFAULT_SEARCH_ENGINE];
  const encoded = encodeURIComponent(query);
  return template.replace("{query}", encoded);
}
