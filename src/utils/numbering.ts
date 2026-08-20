import type { NumberingStyle } from "../constants/numberingConfig";

/**
 * 文本编号纯函数。按 style 给选中文本的每一非空行加序号前缀：
 * - "number-dot"   1. 2. 3.
 * - "letter-dot"   a. b. c. （小写，超 26 接 aa ab…）
 * - "paren"        1) 2) 3)
 * - "cn-ordinal"   一、二、三、（中文小写）
 *
 * 行为约定：
 * - 按 \r?\n 拆行，空行原样保留且不占用序号。
 * - 行首已有任何编号前缀（数字/字母/中文/带圈/带括号）一律先剥离再重新编号。
 * - 单行文本视为一行，加序号 1.
 * - 未知 style 原样返回（防御）。
 */
export function numbering(text: string, style: NumberingStyle): string {
  switch (style) {
    case "number-dot":
    case "letter-dot":
    case "paren":
    case "cn-ordinal":
      break;
    default:
      return text;
  }

  if (text === "") {
    return text;
  }

  // 按行拆分，保留分隔符以最大限度还原原始换行风格（\n 与 \r\n）
  const lines = text.split(/\r?\n/);
  let counter = 0;
  const out = lines.map((line) => {
    if (line.trim() === "") {
      return line;
    }
    counter += 1;
    const stripped = stripLeadingNumber(line);
    return prefixFor(style, counter) + stripped;
  });
  return out.join("\n");
}

/**
 * 行首已有编号前缀则剥离编号本身及其后的分隔空白。
 * 数字分支：点号（含全角．）后不能是数字，避免误吞小数/版本号（1.0、192.168），允许紧凑中文编号（1.甲）。
 * 字母分支：点号后不能是字母或数字，避免误吞英文缩写（i.e.、e.g.），允许字母编号（a.甲）。
 */
function stripLeadingNumber(line: string): string {
  // 匹配行首：可选空白 + 编号前缀 + 可选空白（分隔符），命中后只剥掉前缀与紧跟的分隔空白
  const m = line.match(
    /^\s*(?:\d+[.)．](?!\d)|[a-zA-Z][.)．](?![A-Za-z0-9])|[（(]\d+[)）]|（[一二三四五六七八九十百千]+）|[一二三四五六七八九十百千]+、|[①-⑳⒈-⒛㈠-㈩])\s*/,
  );
  if (!m) {
    return line;
  }
  return line.slice(m[0].length);
}

/** 生成指定样式的第 n 个序号前缀（含分隔符）。 */
function prefixFor(style: NumberingStyle, n: number): string {
  switch (style) {
    case "number-dot":
      return `${n}. `;
    case "letter-dot":
      return `${toLetter(n)}. `;
    case "paren":
      return `${n}) `;
    case "cn-ordinal":
      return `${toChineseOrdinal(n)}、`;
    default:
      return "";
  }
}

/** 1 -> a, 26 -> z, 27 -> aa, 28 -> ab（Excel 列名式） */
function toLetter(n: number): string {
  let s = "";
  let k = n;
  while (k > 0) {
    const rem = (k - 1) % 26;
    s = String.fromCharCode(97 + rem) + s;
    k = Math.floor((k - 1) / 26);
  }
  return s;
}

/** 1 -> 一, 10 -> 十, 11 -> 十一, 20 -> 二十, 21 -> 二十一, 100 -> 一百 */
function toChineseOrdinal(n: number): string {
  if (n <= 0) {
    return String(n);
  }
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n < 10) {
    return digits[n];
  }
  if (n < 20) {
    return n === 10 ? "十" : `十${digits[n - 10]}`;
  }
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? `${digits[tens]}十` : `${digits[tens]}十${digits[ones]}`;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    if (rest === 0) {
      return `${digits[hundreds]}百`;
    }
    const tens = Math.floor(rest / 10);
    const ones = rest % 10;
    // 百位之后十位需读出"X十"，十位为1也读"一十"（一百一十 / 一百一十一）
    let mid = "";
    if (tens === 0) {
      mid = `零${digits[ones]}`;
    } else if (tens === 1) {
      mid = ones === 0 ? "一十" : `一十${digits[ones]}`;
    } else {
      mid = ones === 0 ? `${digits[tens]}十` : `${digits[tens]}十${digits[ones]}`;
    }
    return `${digits[hundreds]}百${mid}`;
  }
  // 1000+ 直接用阿拉伯数字，避免长中文串歧义
  return String(n);
}
