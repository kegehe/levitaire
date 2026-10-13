import { describe, it, expect } from "vitest";
import { clearText } from "./clearText";
import type { ClearOptionId } from "../constants/clearConfig";

describe("clearText 删除空格 (clear-spaces)", () => {
  it("仅删除半角空格，保留制表与换行", () => {
    expect(clearText("a b\tc\nd e", "clear-spaces")).toBe("ab\tc\nde");
  });

  it("连续空格全部删除", () => {
    expect(clearText("a   b", "clear-spaces")).toBe("ab");
  });

  it("无空格时文本不变", () => {
    expect(clearText("abc", "clear-spaces")).toBe("abc");
  });
});

describe("clearText 删除制表符 (clear-tabs)", () => {
  it("删除水平与垂直制表符，保留空格与换行", () => {
    // a \t b ' ' c \v d \n e → 删 \t \v → ab cd\ne
    expect(clearText("a\tb c\vd\ne", "clear-tabs")).toBe("ab cd\ne");
  });
});

describe("clearText 删除换行符 (clear-newlines)", () => {
  it("CRLF / CR / LF 一并删除，整段合并成一行", () => {
    expect(clearText("a\r\nb\rc\nd", "clear-newlines")).toBe("abcd");
  });

  it("保留空格与制表符", () => {
    expect(clearText("a b\nc\td", "clear-newlines")).toBe("a bc\td");
  });
});

describe("clearText 删除所有空白 (clear-whitespace)", () => {
  it("删除 \\s 与全角空格 U+3000", () => {
    expect(clearText("a b\tc\nd　e", "clear-whitespace")).toBe("abcde");
  });
});

describe("clearText 删除字母 (clear-letters)", () => {
  it("删除字母，保留数字/中文/标点", () => {
    expect(clearText("a1中 B2文,!", "clear-letters")).toBe("1中 2文,!");
  });

  it("大小写均删除", () => {
    expect(clearText("AbCdE123", "clear-letters")).toBe("123");
  });

  it("删除全角字母与带音标字母", () => {
    expect(clearText("ＡＢｃ éü ñ", "clear-letters")).toBe("  ");
  });

  it("删除希腊/西里尔等非拉丁字母", () => {
    expect(clearText("αβγ Привет", "clear-letters")).toBe(" ");
  });

  it("保留汉字（含扩展区），汉字由 clear-chinese 负责", () => {
    // 㐀 = 扩展 A 区，𠀀 = 扩展 B 区（代理对），豈 = 兼容表意
    expect(clearText("中a㐀b𠀀c豈d", "clear-letters")).toBe("中㐀𠀀豈");
  });

  it("连同组合附加符号一并删除，不留孤立符号", () => {
    // NFD 分解的 café = 字母 e + 组合尖音符 U+0301
    expect(clearText("cafe\u0301", "clear-letters")).toBe("");
    // 天城文 कि（基字 क + 元音符号 ि）
    expect(clearText("\u0915\u093F", "clear-letters")).toBe("");
  });

  it("不误删 emoji 的变体选择符", () => {
    // 变体选择符 U+FE0F 前是符号 U+2764 而非字母，不属于本次删除范围
    expect(clearText("\u2764\uFE0F", "clear-letters")).toBe("\u2764\uFE0F");
  });
});

describe("clearText 删除数字 (clear-digits)", () => {
  it("删除 0-9，保留字母/中文/标点", () => {
    expect(clearText("a1中 B2文,!", "clear-digits")).toBe("a中 B文,!");
  });

  it("删除全角数字与带圈/罗马数字", () => {
    expect(clearText("０１２①②Ⅻ", "clear-digits")).toBe("");
  });

  it("不误删字母与汉字", () => {
    expect(clearText("中a文b", "clear-digits")).toBe("中a文b");
  });

  it("带键帽的 emoji 数字整串删除，不留组合符号", () => {
    // 键帽序列 = 数字 1 + 变体选择符 U+FE0F + 组合包围键帽 U+20E3
    expect(clearText("1\uFE0F\u20E3", "clear-digits")).toBe("");
  });
});

describe("clearText 删除中文 (clear-chinese)", () => {
  it("删除 CJK 统一表意，保留字母/数字/标点", () => {
    expect(clearText("a1中 B2文,!", "clear-chinese")).toBe("a1 B2,!");
  });

  it("删除扩展区与兼容表意汉字，不残留代理对碎片", () => {
    // 㐀 = 扩展 A 区，𠀀 = 扩展 B 区（代理对），豈 = 兼容表意，〇 = U+3007
    expect(clearText("㐀a𠀀b豈c〇d", "clear-chinese")).toBe("abcd");
  });

  it("保留非汉字的 CJK 字符（标点/假名/谚文）", () => {
    expect(clearText("中，。ひ한", "clear-chinese")).toBe("，。ひ한");
  });

  it("连同组合附加符号一并删除，不留孤立符号", () => {
    // 汉 + 组合浊点 U+3099，中 + 组合尖音符 U+0301
    expect(clearText("漢\u3099中\u0301", "clear-chinese")).toBe("");
    // 标点后的变体选择符 U+FE0F 不属于被删字符，保留
    expect(clearText("，\uFE0F", "clear-chinese")).toBe("，\uFE0F");
  });

  it("emoji 不受影响（非汉字字符）", () => {
    expect(clearText("中😀文", "clear-chinese")).toBe("😀");
  });
});

describe("clearText 防御", () => {
  it("未知 optionId 原样返回", () => {
    const id = "unknown-xxx" as unknown as ClearOptionId;
    expect(clearText("a b c", id)).toBe("a b c");
  });

  it("空字符串输入返回空字符串", () => {
    expect(clearText("", "clear-spaces")).toBe("");
  });
});
