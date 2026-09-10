import { describe, it, expect } from "vitest";
import { charCount } from "./charCount";

describe("charCount 空字符串", () => {
  it("空字符串各项归零（行数也为 0）", () => {
    const r = charCount("");
    expect(r).toEqual({
      charsWithSpaces: 0,
      charsNoSpaces: 0,
      words: 0,
      lines: 0,
      nonEmptyLines: 0,
      paragraphs: 0,
      sentences: 0,
      bytes: 0,
      digits: 0,
      punctuation: 0,
      letters: 0,
    });
  });
});

describe("charCount 字符数", () => {
  it("字符数(含空格)按 UTF-16 码元计，含空格", () => {
    expect(charCount("a b c").charsWithSpaces).toBe(5);
  });

  it("字符数(不含空格)去除半角空格与全角空格", () => {
    expect(charCount("a b　c").charsNoSpaces).toBe(3);
  });

  it("emoji 代理对按 2 个码元计（与 Word 一致）", () => {
    // 😀 为代理对，length === 2
    expect(charCount("😀").charsWithSpaces).toBe(2);
  });
});

describe("charCount 字数", () => {
  it("纯英文按单词数计", () => {
    expect(charCount("hello world foo").words).toBe(3);
  });

  it("纯中文逐字计", () => {
    expect(charCount("你好世界").words).toBe(4);
  });

  it("中英混排：英文词 + 中文字 + 数字串分别计数", () => {
    // hello(1) + 世界(2) + 123(1) = 4
    expect(charCount("hello 世界 123").words).toBe(4);
  });
});

describe("charCount 行数", () => {
  it("单行文本行数为 1", () => {
    expect(charCount("abc").lines).toBe(1);
  });

  it("多行按换行符分割", () => {
    expect(charCount("a\nb\nc").lines).toBe(3);
  });

  it("CRLF / CR / LF 一并识别", () => {
    expect(charCount("a\r\nb\rc\nd").lines).toBe(4);
  });

  it("非空行数过滤空行", () => {
    expect(charCount("a\n\nb\n  \nc").nonEmptyLines).toBe(3);
  });
});

describe("charCount 段落", () => {
  it("按空行分隔段落", () => {
    expect(charCount("第一段\n\n第二段\n\n第三段").paragraphs).toBe(3);
  });

  it("连续空行合并为一次分隔", () => {
    expect(charCount("第一段\n\n\n\n第二段").paragraphs).toBe(2);
  });

  it("无空行时为 1 段", () => {
    expect(charCount("连续文本无空行").paragraphs).toBe(1);
  });
});

describe("charCount 句子", () => {
  it("按中文句末标点计", () => {
    expect(charCount("你好。世界！测试？").sentences).toBe(3);
  });

  it("按英文句末标点计", () => {
    expect(charCount("Hello. World! Test?").sentences).toBe(3);
  });

  it("连续句末标点算一句", () => {
    expect(charCount("什么？！").sentences).toBe(1);
  });

  it("小数点的点（3.14）不计为句子结束", () => {
    expect(charCount("圆周率约等于 3.14").sentences).toBe(0);
  });

  it("多段数字内部点不计句末，句末标点照常计", () => {
    expect(charCount("版本 v1.2.3 已发布。当前占用 3.14 GB。").sentences).toBe(2);
  });

  it("数字后的真实句号仍算句末", () => {
    // "3." 后跟空格，属真实句末而非小数点
    expect(charCount("得到结果 3. 下一个环节。").sentences).toBe(2);
  });
});

describe("charCount 字节", () => {
  it("ASCII 字符每字节 1", () => {
    expect(charCount("abc").bytes).toBe(3);
  });

  it("中文每字 3 字节（UTF-8）", () => {
    expect(charCount("你好").bytes).toBe(6);
  });

  it("emoji 按 UTF-8 字节数计", () => {
    // 😀 U+1F600 → 4 字节
    expect(charCount("😀").bytes).toBe(4);
  });
});

describe("charCount 数字串", () => {
  it("连续数字算一个串", () => {
    expect(charCount("a123b456c7").digits).toBe(3);
  });

  it("无数值时为 0", () => {
    expect(charCount("abc").digits).toBe(0);
  });
});

describe("charCount 标点", () => {
  it("统计中英文标点字符总数", () => {
    // 。 ！ ， (全角) + . , ! (半角) = 6
    expect(charCount("。！，.,!").punctuation).toBe(6);
  });

  it("覆盖全角破折号、间隔号、省略号", () => {
    // —（U+2014）·（U+00B7）…（U+2026）各 1
    expect(charCount("—·…").punctuation).toBe(3);
  });

  it("全角空格不计入标点（属空白）", () => {
    expect(charCount("a　b").punctuation).toBe(0);
  });

  it("无标点时为 0", () => {
    expect(charCount("abc123").punctuation).toBe(0);
  });

  it("全角字母不计入标点", () => {
    // ＡＢＣ 为全角大写字母 U+FF21–U+FF23，属字母而非标点
    expect(charCount("ＡＢＣ").punctuation).toBe(0);
  });

  it("全角数字不计入标点", () => {
    // １２３ 为全角数字 U+FF11–U+FF13，属数字而非标点
    expect(charCount("１２３").punctuation).toBe(0);
  });

  it("全角字母数字与全角标点混排时只计标点", () => {
    // ＡＢＣ(3) ，(1) １２３(3) 。(1) → 标点仅 ，。 共 2
    expect(charCount("ＡＢＣ，１２３。").punctuation).toBe(2);
  });
});

describe("charCount 字母", () => {
  it("统计 A-Za-z 字符总数", () => {
    expect(charCount("aBcD123").letters).toBe(4);
  });

  it("无字母时为 0", () => {
    expect(charCount("123世界").letters).toBe(0);
  });
});

describe("charCount 综合场景", () => {
  it("中英混排多段文本统计一致", () => {
    const text = "Hello 世界。\n\nThis is 测试 123!";
    const r = charCount(text);
    // 字数：Hello(1) + 世界(2) + This(1) + is(1) + 测试(2) + 123(1) = 8
    expect(r.words).toBe(8);
    // 行数：1 段间换行 + 内容行 = 3 行（含中间空行）
    expect(r.lines).toBe(3);
    // 段落：2
    expect(r.paragraphs).toBe(2);
    // 句子：。和 ! 共 2 句
    expect(r.sentences).toBe(2);
    // 字母：Hello(5) + This(4) + is(2) = 11
    expect(r.letters).toBe(11);
    // 数字串：123 共 1 串
    expect(r.digits).toBe(1);
  });
});
