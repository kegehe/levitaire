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
  it("删除 ASCII 字母，保留数字/中文/标点", () => {
    expect(clearText("a1中 B2文,!", "clear-letters")).toBe("1中 2文,!");
  });

  it("大小写均删除", () => {
    expect(clearText("AbCdE123", "clear-letters")).toBe("123");
  });
});

describe("clearText 删除数字 (clear-digits)", () => {
  it("删除 0-9，保留字母/中文/标点", () => {
    expect(clearText("a1中 B2文,!", "clear-digits")).toBe("a中 B文,!");
  });
});

describe("clearText 删除中文 (clear-chinese)", () => {
  it("删除 CJK 统一表意，保留字母/数字/标点", () => {
    expect(clearText("a1中 B2文,!", "clear-chinese")).toBe("a1 B2,!");
  });

  it("emoji 不受影响（不在 CJK 基本区）", () => {
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
