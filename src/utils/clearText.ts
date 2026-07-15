import type { ClearOptionId } from "../constants/clearConfig";

/**
 * 文本清除纯函数。按 optionId 选择清除目标：
 * - "clear-spaces"    删除半角空格 U+0020
 * - "clear-tabs"      删除制表符 \t \v
 * - "clear-newlines"  删除换行符 \r \n（整段合并成一行）
 * - "clear-whitespace"删除所有空白（\s + 全角空格 U+3000）
 * - "clear-letters"   删除所有 ASCII 字母 A-Za-z
 * - "clear-digits"    删除所有 ASCII 数字 0-9
 * - "clear-chinese"   删除所有中文（CJK 统一表意 U+4E00–U+9FFF）
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
      return text.replace(/[A-Za-z]/g, "");
    case "clear-digits":
      return text.replace(/[0-9]/g, "");
    case "clear-chinese":
      // CJK 统一表意基本区 U+4E00–U+9FFF；扩展区（罕见字）不在此范围
      return text.replace(/[一-鿿]/g, "");
    default:
      // 防御：未知清除项原样返回
      return text;
  }
}
