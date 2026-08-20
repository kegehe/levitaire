import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SEARCH_ENGINE,
  normalizeSearchEngine,
  fetchSearchEngine,
  saveSearchEngine,
  buildSearchUrl,
  type SearchEngineId,
} from "./searchEngineConfig";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeSearchEngine", () => {
  it("合法引擎 ID 原样保留", () => {
    expect(normalizeSearchEngine("google")).toBe("google");
    expect(normalizeSearchEngine("baidu")).toBe("baidu");
    expect(normalizeSearchEngine("bing")).toBe("bing");
    expect(normalizeSearchEngine("duckduckgo")).toBe("duckduckgo");
    expect(normalizeSearchEngine("sogou")).toBe("sogou");
  });

  it("未知引擎 ID 回退为默认 Bing", () => {
    expect(normalizeSearchEngine("yahoo")).toBe(DEFAULT_SEARCH_ENGINE);
  });

  it("非字符串（对象/数字）回退为默认", () => {
    expect(normalizeSearchEngine({ id: "google" })).toBe(DEFAULT_SEARCH_ENGINE);
    expect(normalizeSearchEngine(123)).toBe(DEFAULT_SEARCH_ENGINE);
  });

  it("null/undefined 回退为默认", () => {
    expect(normalizeSearchEngine(null)).toBe(DEFAULT_SEARCH_ENGINE);
    expect(normalizeSearchEngine(undefined)).toBe(DEFAULT_SEARCH_ENGINE);
  });
});

describe("fetchSearchEngine", () => {
  it("后端返回合法 ID 时正确读取", async () => {
    mockInvoke.mockResolvedValueOnce("google");
    const result = await fetchSearchEngine();
    expect(result).toBe("google");
    expect(mockInvoke).toHaveBeenCalledWith("get_search_engine");
  });

  it("后端返回脏数据时归一化", async () => {
    mockInvoke.mockResolvedValueOnce("unknown-engine");
    const result = await fetchSearchEngine();
    expect(result).toBe(DEFAULT_SEARCH_ENGINE);
  });

  it("后端返回空串时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("");
    const result = await fetchSearchEngine();
    expect(result).toBe(DEFAULT_SEARCH_ENGINE);
  });

  it("invoke 抛错时回退为默认", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("config read failed"));
    const result = await fetchSearchEngine();
    expect(result).toBe(DEFAULT_SEARCH_ENGINE);
  });
});

describe("saveSearchEngine", () => {
  it("调用 set_search_engine 并持久化引擎 ID", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveSearchEngine("baidu");
    expect(mockInvoke).toHaveBeenCalledWith("set_search_engine", { engine: "baidu" });
  });
});

describe("buildSearchUrl", () => {
  it("Bing：空格编码为 %20", () => {
    expect(buildSearchUrl("bing", "hello world")).toBe(
      "https://www.bing.com/search?q=hello%20world",
    );
  });

  it("Google：查询词编码", () => {
    expect(buildSearchUrl("google", "你好世界")).toBe(
      "https://www.google.com/search?q=%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C",
    );
  });

  it("百度：使用 wd 参数", () => {
    expect(buildSearchUrl("baidu", "test")).toBe("https://www.baidu.com/s?wd=test");
  });

  it("DuckDuckGo：使用 q 参数", () => {
    expect(buildSearchUrl("duckduckgo", "query")).toBe("https://duckduckgo.com/?q=query");
  });

  it("搜狗：使用 query 参数", () => {
    expect(buildSearchUrl("sogou", "搜索")).toBe(
      "https://www.sogou.com/web?query=%E6%90%9C%E7%B4%A2",
    );
  });

  it("特殊字符正确编码（&、=、?、#）", () => {
    expect(buildSearchUrl("bing", "a&b=c?d=e")).toBe(
      "https://www.bing.com/search?q=a%26b%3Dc%3Fd%3De",
    );
  });

  it("URL 作为查询词时整体编码", () => {
    expect(buildSearchUrl("bing", "https://example.com/path?q=1#frag")).toBe(
      "https://www.bing.com/search?q=https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1%23frag",
    );
  });

  it("空字符串查询生成空 q 参数（引擎首页）", () => {
    expect(buildSearchUrl("bing", "")).toBe("https://www.bing.com/search?q=");
  });

  it("未知引擎 ID 回退到默认 Bing 模板（防御）", () => {
    expect(buildSearchUrl("unknown" as SearchEngineId, "test")).toBe(
      "https://www.bing.com/search?q=test",
    );
  });

  it("换行与连续空格按 encodeURIComponent 编码", () => {
    expect(buildSearchUrl("bing", "line1\nline2  line3")).toBe(
      "https://www.bing.com/search?q=line1%0Aline2%20%20line3",
    );
  });
});
