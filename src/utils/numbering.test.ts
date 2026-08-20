import { describe, it, expect } from "vitest";
import { numbering } from "./numbering";
import type { NumberingStyle } from "../constants/numberingConfig";

describe("numbering 边界", () => {
  it("空字符串原样返回", () => {
    expect(numbering("", "number-dot")).toBe("");
  });

  it("未知样式原样返回（防御）", () => {
    expect(numbering("甲\n乙", "unknown" as NumberingStyle)).toBe("甲\n乙");
  });
});

describe("numbering 单行", () => {
  it("单行视为一行，加序号 1.（number-dot）", () => {
    expect(numbering("甲", "number-dot")).toBe("1. 甲");
  });

  it("单行字母样式", () => {
    expect(numbering("甲", "letter-dot")).toBe("a. 甲");
  });

  it("单行括号样式", () => {
    expect(numbering("甲", "paren")).toBe("1) 甲");
  });

  it("单行中文序号", () => {
    expect(numbering("甲", "cn-ordinal")).toBe("一、甲");
  });
});

describe("numbering 多行", () => {
  it("number-dot 顺序编号", () => {
    expect(numbering("甲\n乙\n丙", "number-dot")).toBe("1. 甲\n2. 乙\n3. 丙");
  });

  it("CRLF 换行按 \\n 还原", () => {
    expect(numbering("甲\r\n乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("空行原样保留且不占用序号", () => {
    expect(numbering("甲\n\n乙", "number-dot")).toBe("1. 甲\n\n2. 乙");
  });

  it("末尾空行保留", () => {
    expect(numbering("甲\n乙\n", "number-dot")).toBe("1. 甲\n2. 乙\n");
  });

  it("首尾空白行均保留", () => {
    expect(numbering("\n甲\n乙\n\n", "number-dot")).toBe("\n1. 甲\n2. 乙\n\n");
  });
});

describe("numbering 字母样式超 26", () => {
  it("第 27 个为 aa", () => {
    const text = Array.from({ length: 27 }, (_, i) => `x${i + 1}`).join("\n");
    const out = numbering(text, "letter-dot");
    const lines = out.split("\n");
    expect(lines[0]).toBe("a. x1");
    expect(lines[25]).toBe("z. x26");
    expect(lines[26]).toBe("aa. x27");
  });
});

describe("numbering 中文序号进位", () => {
  it("十、十一、二十、二十一", () => {
    const text = Array.from({ length: 21 }, (_, i) => `行${i + 1}`).join("\n");
    const out = numbering(text, "cn-ordinal");
    const lines = out.split("\n");
    expect(lines[0]).toBe("一、行1");
    expect(lines[9]).toBe("十、行10");
    expect(lines[10]).toBe("十一、行11");
    expect(lines[19]).toBe("二十、行20");
    expect(lines[20]).toBe("二十一、行21");
  });

  it("百位：一百、一百零一、二百一十", () => {
    const cases: [number, string][] = [
      [100, "一百"],
      [101, "一百零一"],
      [110, "一百一十"],
      [111, "一百一十一"],
      [210, "二百一十"],
    ];
    for (const [n, expectLabel] of cases) {
      const text = Array.from({ length: n }, () => "x").join("\n");
      const out = numbering(text, "cn-ordinal");
      const line = out.split("\n")[n - 1];
      expect(line).toBe(`${expectLabel}、x`);
    }
  });
});

describe("numbering 剥离旧编号", () => {
  it("剥离数字点号 1. 2. 后重新编号", () => {
    expect(numbering("1. 甲\n2. 乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("剥离旧编号后切换样式", () => {
    expect(numbering("1. 甲\n2. 乙", "letter-dot")).toBe("a. 甲\nb. 乙");
  });

  it("剥离括号 1) 2)", () => {
    expect(numbering("1) 甲\n2) 乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("剥离全角括号 (1)(2)", () => {
    expect(numbering("（1）甲\n（2）乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("剥离字母 a. b.", () => {
    expect(numbering("a. 甲\nb. 乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("剥离中文序号 一、二、", () => {
    expect(numbering("一、甲\n二、乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("剥离中文全角括号 （一）（二）", () => {
    expect(numbering("（一）甲\n（二）乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("无前缀的行原样加号，有前缀的剥离后重号（混合）", () => {
    expect(numbering("1. 甲\n乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("剥离后保留原始缩进内容（前导空白被前缀吞噬，内容保留）", () => {
    expect(numbering("  1. 甲", "number-dot")).toBe("1. 甲");
  });

  it("版本号 1.0 不被误判为编号（数字后须为空白/行尾）", () => {
    expect(numbering("1.0 是版本号", "number-dot")).toBe("1. 1.0 是版本号");
  });

  it("小数 10.5 不被误判为编号", () => {
    expect(numbering("10.5 版本", "number-dot")).toBe("1. 10.5 版本");
  });

  it("英文缩写 i.e. 不被误判为字母编号", () => {
    expect(numbering("i.e. 即", "number-dot")).toBe("1. i.e. 即");
  });

  it("IP 形态 192.168 不被误判为编号", () => {
    expect(numbering("192.168.x", "number-dot")).toBe("1. 192.168.x");
  });

  it("紧凑中文编号 1.甲（点后无空格）应剥离", () => {
    expect(numbering("1.甲\n2.乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("全角句号 1．甲 应剥离", () => {
    expect(numbering("1．甲\n2．乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("字母编号 a.甲（点后中文）应剥离", () => {
    expect(numbering("a.甲\nb.乙", "number-dot")).toBe("1. 甲\n2. 乙");
  });

  it("数字编号后跟英文正文应剥离", () => {
    expect(numbering("1.hello", "number-dot")).toBe("1. hello");
  });
});
