/**
 * 简体与繁体中文互转。
 *
 * 词库较大（opencc-js 内置 OpenCC 简繁词典），采用动态 import 按需加载：
 * 工具栏启动时不进入初始包，仅在用户首次点击转换按钮时才加载对应方向的数据。
 * 转换器实例以模块级缓存，避免多次点击重复构建 Trie。
 *
 * 说明：转换依据 OpenCC 短语词典按词映射，可正确处理一对多字
 * （如 后→後/后、发→發/髮、云→雲/云）；不做地区常用词之间的本地化替换。
 */

type TextConverter = (text: string) => string;

let toTraditionalConverter: TextConverter | null = null;
let toSimplifiedConverter: TextConverter | null = null;

/** 加载「简体 → 繁体」转换器并缓存 */
async function getToTraditional(): Promise<TextConverter> {
  if (!toTraditionalConverter) {
    const { Converter } = await import("opencc-js/cn2t");
    toTraditionalConverter = Converter({ from: "cn", to: "tw" });
  }
  return toTraditionalConverter;
}

/** 加载「繁体 → 简体」转换器并缓存 */
async function getToSimplified(): Promise<TextConverter> {
  if (!toSimplifiedConverter) {
    const { Converter } = await import("opencc-js/t2cn");
    toSimplifiedConverter = Converter({ from: "tw", to: "cn" });
  }
  return toSimplifiedConverter;
}

/** 简体转繁体。加载/转换失败时抛出异常，由调用方提示用户。 */
export async function convertToTraditional(text: string): Promise<string> {
  const convert = await getToTraditional();
  return convert(text);
}

/** 繁体转简体。加载/转换失败时抛出异常，由调用方提示用户。 */
export async function convertToSimplified(text: string): Promise<string> {
  const convert = await getToSimplified();
  return convert(text);
}
