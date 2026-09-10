import { describe, it, expect } from "vitest";
import { convertToTraditional, convertToSimplified } from "./chineseConvert";

describe("convertToTraditional（简体 → 繁体）", () => {
  it("常用简体词转换为台湾正体", async () => {
    expect(await convertToTraditional("软件开发")).toBe("軟件開發");
  });

  it("按词语区分一对多字（后/面/云/发）", async () => {
    expect(await convertToTraditional("我后面有一个面条店，里面卖头发和云后面")).toBe(
      "我後面有一個麵條店，裡面賣頭髮和雲後面",
    );
  });

  it("繁体已存在或相同的字保持不变", async () => {
    expect(await convertToTraditional("你好世界")).toBe("你好世界");
  });

  it("保留换行、空白与非中文内容", async () => {
    expect(await convertToTraditional("简体中文测试\n第二行 Hello 2024")).toBe(
      "簡體中文測試\n第二行 Hello 2024",
    );
  });
});

describe("convertToSimplified（繁体 → 简体）", () => {
  it("常用繁体词转换为简体", async () => {
    expect(await convertToSimplified("軟件開發")).toBe("软件开发");
  });

  it("按词语归并一对多字", async () => {
    expect(await convertToSimplified("我後面有一個麵條店，裏面賣頭髮和雲後面")).toBe(
      "我后面有一个面条店，里面卖头发和云后面",
    );
  });

  it("保留换行、空白与非中文内容", async () => {
    expect(await convertToSimplified("漢字與繁體中文測試\nHello 2024")).toBe(
      "汉字与繁体中文测试\nHello 2024",
    );
  });
});

describe("繁简往返一致性", () => {
  it("转繁体后再转简体还原原文", async () => {
    const original = "我后面有一个面条店，里面卖头发和云后面";
    expect(await convertToSimplified(await convertToTraditional(original))).toBe(original);
  });
});
