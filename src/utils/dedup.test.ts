import { describe, it, expect } from "vitest";
import { dedup } from "./dedup";
import type { DedupMode } from "../constants/dedupConfig";

const mode = (granularity: DedupMode["granularity"], charSubMode: DedupMode["charSubMode"] = "all"): DedupMode => ({
  granularity,
  charSubMode,
});

describe("dedup 按行去重 (line)", () => {
  it("移除重复行，保留首次出现", () => {
    expect(dedup("苹果\n香蕉\n苹果\n橙子\n香蕉", mode("line"))).toBe("苹果\n香蕉\n橙子");
  });

  it("忽略行首尾空白进行去重，保留首次原始格式", () => {
    expect(dedup("  hello  \nhello\nworld", mode("line"))).toBe("  hello  \nworld");
  });

  it("无重复行时文本不变", () => {
    expect(dedup("a\nb\nc", mode("line"))).toBe("a\nb\nc");
  });

  it("所有行相同时只保留一行", () => {
    expect(dedup("same\nsame\nsame", mode("line"))).toBe("same");
  });

  it("多个空行只保留一个", () => {
    expect(dedup("a\n\n\nb\n", mode("line"))).toBe("a\n\nb");
  });

  it("处理 \\r\\n 换行符，输出统一用 \\n", () => {
    expect(dedup("a\r\nb\r\na\r\nc", mode("line"))).toBe("a\nb\nc");
  });

  it("混合 \\r\\n 和 \\n 换行符统一处理", () => {
    expect(dedup("a\r\nb\nc\r\na\nc", mode("line"))).toBe("a\nb\nc");
  });

  it("只有换行符的文本去重为空字符串", () => {
    expect(dedup("\n\n\n", mode("line"))).toBe("");
  });

  it("空字符串去重后仍为空字符串", () => {
    expect(dedup("", mode("line"))).toBe("");
  });

  it("Tab 和空格 trim 后视为相同行", () => {
    expect(dedup("hello\n\thello\nhello", mode("line"))).toBe("hello");
  });

  it("大小写敏感（A 与 a 视为不同行）", () => {
    expect(dedup("Apple\napple", mode("line"))).toBe("Apple\napple");
  });

  it("Unicode 文本（emoji、CJK）正确去重", () => {
    expect(dedup("🍎 苹果\n🍌 香蕉\n🍎 苹果\n🍊 橙子\n🍌 香蕉", mode("line"))).toBe(
      "🍎 苹果\n🍌 香蕉\n🍊 橙子",
    );
  });
});

describe("dedup 按词去重 (word)", () => {
  it("单行内移除重复词，保留首次顺序", () => {
    expect(dedup("a b a c", mode("word"))).toBe("a b c");
  });

  it("保留逗号空格分隔符", () => {
    expect(dedup("苹果, 香蕉, 苹果", mode("word"))).toBe("苹果, 香蕉");
  });

  it("多行各自行内按词去重，不跨行", () => {
    expect(dedup("a b a\nx y x", mode("word"))).toBe("a b\nx y");
  });

  it("无重复词时文本不变", () => {
    expect(dedup("a b c", mode("word"))).toBe("a b c");
  });

  it("大小写敏感（Apple 与 apple 视为不同词）", () => {
    expect(dedup("Apple apple Apple", mode("word"))).toBe("Apple apple");
  });

  it("分号分隔的重复词去重", () => {
    expect(dedup("x;y;x;z", mode("word"))).toBe("x;y;z");
  });

  it("空字符串去重后仍为空字符串", () => {
    expect(dedup("", mode("word"))).toBe("");
  });

  it("仅空白字符不产生词，保持原样", () => {
    expect(dedup("   ", mode("word"))).toBe("   ");
  });

  it("保留行首空白", () => {
    expect(dedup("  a a b", mode("word"))).toBe("  a b");
  });

  it("Unicode 词（含 emoji）行内去重", () => {
    expect(dedup("🍎 🍌 🍎 🍊", mode("word"))).toBe("🍎 🍌 🍊");
  });
});

describe("dedup 按字符去重 - 逐字 (char/all)", () => {
  it("跨行逐字去重，保留首次出现", () => {
    expect(dedup("apple", mode("char", "all"))).toBe("aple");
  });

  it("CJK 字符逐字去重", () => {
    expect(dedup("苹果苹果", mode("char", "all"))).toBe("苹果");
  });

  it("换行符作为字符参与去重", () => {
    expect(dedup("\n\n\n", mode("char", "all"))).toBe("\n");
  });

  it("跨行去重（换行字符只保留首次）", () => {
    expect(dedup("a\nb\na", mode("char", "all"))).toBe("a\nb");
  });

  it("emoji 正确按码点去重", () => {
    expect(dedup("🍎🍎🍌", mode("char", "all"))).toBe("🍎🍌");
  });

  it("大小写敏感（A 与 a 视为不同字符）", () => {
    expect(dedup("AaA", mode("char", "all"))).toBe("Aa");
  });

  it("空字符串去重后仍为空字符串", () => {
    expect(dedup("", mode("char", "all"))).toBe("");
  });
});

describe("dedup 按字符去重 - 行内逐字 (char/line)", () => {
  it("行内逐字去重，保留换行结构", () => {
    expect(dedup("aab\nbba", mode("char", "line"))).toBe("ab\nba");
  });

  it("不跨行去重（同字符在不同行都保留）", () => {
    expect(dedup("ab\nab", mode("char", "line"))).toBe("ab\nab");
  });

  it("CJK 行内逐字", () => {
    expect(dedup("苹果果\n蕉蕉蕉", mode("char", "line"))).toBe("苹果\n蕉");
  });

  it("换行符不在行内，保留行数", () => {
    expect(dedup("aa\n\nbb", mode("char", "line"))).toBe("a\n\nb");
  });
});

describe("dedup 按字符去重 - 仅连续重复 (char/consecutive)", () => {
  it("压缩连续重复字符", () => {
    expect(dedup("aaabbb", mode("char", "consecutive"))).toBe("ab");
  });

  it("不压缩间隔重复", () => {
    expect(dedup("aba", mode("char", "consecutive"))).toBe("aba");
  });

  it("跨行连续（换行符连续只保留一个）", () => {
    expect(dedup("a\n\n\nb", mode("char", "consecutive"))).toBe("a\nb");
  });

  it("CJK 连续重复压缩", () => {
    expect(dedup("苹苹苹果果", mode("char", "consecutive"))).toBe("苹果");
  });

  it("emoji 连续重复压缩", () => {
    expect(dedup("🍎🍎🍎🍌", mode("char", "consecutive"))).toBe("🍎🍌");
  });

  it("无连续重复时文本不变", () => {
    expect(dedup("abcdef", mode("char", "consecutive"))).toBe("abcdef");
  });

  it("空字符串去重后仍为空字符串", () => {
    expect(dedup("", mode("char", "consecutive"))).toBe("");
  });
});
