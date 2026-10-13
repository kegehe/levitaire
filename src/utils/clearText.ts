import type { ClearOptionId } from "../constants/clearConfig";

/**
 * 文本清除纯函数。按 optionId 选择清除目标：
 * - "clear-spaces"    删除半角空格 U+0020
 * - "clear-tabs"      删除制表符 \t \v
 * - "clear-newlines"  删除换行符 \r \n（整段合并成一行）
 * - "clear-whitespace"删除所有空白（\s + 全角空格 U+3000）
 * - "clear-letters"   删除所有字母（\p{L}+\p{M}*：全角 ＡＢＣ、带音标、希腊/西里尔等），汉字除外
 * - "clear-digits"    删除所有数字（\p{N}+\p{M}*：0-9、全角 ０-９、带圈 ①②、罗马数字 Ⅻ 等）
 * - "clear-chinese"   删除所有汉字（\p{Script=Han}+\p{M}*：基本区 + 扩展 A–I 区 + 兼容表意等）
 *
 * 未知 optionId 原样返回（防御）。
 */
export function clearText(text: string, optionId: ClearOptionId): string {
  switch (optionId) {
    case "clear-spaces":
      // 仅半角空格；保留制表符/换行等其它空白
      return text.replace(/ /g, "");
    case "clear-tabs":
      // 水平制表符 \t 与垂直制表符 \v
      return text.replace(/[\t\v]/g, "");
    case "clear-newlines":
      // \r\n 与 \r、\n 一并删除，整段合并成一行
      return text.replace(/\r\n|\r|\n/g, "");
    case "clear-whitespace":
      // \s 覆盖半角空格/制表/换行/垂直制表/换页等；额外补全角空格 U+3000
      return text.replace(/[\s　]/g, "");
    case "clear-letters":
      // 所有字母（含全角 ＡＢＣ、带音标字母、希腊/西里尔/假名/谚文等），连同紧跟其后的组合
      // 附加符号一并删除（如 NFD 分解的 e+U+0301、天城文元音符号），避免删走基字后留下孤立符号；
      // 汉字不在此列——汉字由 "clear-chinese" 负责，两项同时启用即"删除所有语言的字母"
      return text.replace(/(?!\p{Script=Han})\p{L}\p{M}*/gu, "");
    case "clear-digits":
      // \p{N} 覆盖 0-9、全角 ０-９、带圈 ①②、罗马数字 Ⅻ、分数 ½ 等所有数字类字符；
      // 后随附加符号一并删除（如数字键帽的 VS16 U+FE0F + 组合包围键帽 U+20E3）
      return text.replace(/\p{N}\p{M}*/gu, "");
    case "clear-chinese":
      // \p{Script=Han} 覆盖基本区 U+4E00–U+9FFF、扩展 A–I 区（含增补平面）、兼容表意、〇 等；
      // 连同其后的组合附加符号一并删除（避免留下孤立符号）
      return text.replace(/\p{Script=Han}\p{M}*/gu, "");
    default:
      // 防御：未知清除项原样返回
      return text;
  }
}
