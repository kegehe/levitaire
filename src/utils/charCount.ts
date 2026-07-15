/** 字符统计结果 */
export interface CharCountResult {
  /** 字符数（含空格）—— UTF-16 码元数，emoji 代理对算 2，与 Word「字符数」一致 */
  charsWithSpaces: number;
  /** 字符数（不含空格）—— 去除所有空白（含全角空格）后剩余字符数 */
  charsNoSpaces: number;
  /** 字数 —— 中文逐字计 + 英文/数字连续串各计一个词 */
  words: number;
  /** 行数 —— 按换行符分割，空文本为 0 */
  lines: number;
  /** 非空行数 —— trim 后非空的行 */
  nonEmptyLines: number;
  /** 段落数 —— 按空行（连续换行）分隔的段落 */
  paragraphs: number;
  /** 句子数 —— 按中英文句末标点计 */
  sentences: number;
  /** UTF-8 字节数 */
  bytes: number;
  /** 数字串数 —— 连续数字段数量 */
  digits: number;
  /** 标点数 —— 中英文标点字符总数 */
  punctuation: number;
  /** 英文字母数 —— A-Za-z 字符总数 */
  letters: number;
}

/** 安全计数：match 可能为 null，统一归零 */
function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * 字符统计纯函数。无副作用，入参字符串，返回结构化统计结果。
 * 空字符串入参时各项归零（行数也为 0）。
 */
export function charCount(text: string): CharCountResult {
  if (!text) {
    return {
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
    };
  }

  // 字符数：UTF-16 码元数（emoji 代理对算 2，与 Word 一致）
  const charsWithSpaces = text.length;

  // 字符数（不含空格）：去除所有空白与全角空格 U+3000
  const charsNoSpaces = text.replace(/[\s　]/g, "").length;

  // 字数：中文逐字（CJK 统一表意基本区）+ 英文/数字连续串各一个词
  const chineseChars = countMatches(text, /[一-鿿]/g);
  const westernWords = countMatches(text, /[A-Za-z0-9]+/g);
  const words = chineseChars + westernWords;

  // 行数：按 CRLF / CR / LF 分割。空文本已前置返回 0，此处至少为 1
  const linesArray = text.split(/\r\n|\r|\n/);
  const lines = linesArray.length;
  const nonEmptyLines = linesArray.filter((l) => l.trim().length > 0).length;

  // 段落数：按空行（连续换行）分隔，过滤空段
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  // 句子数：按中英文句末标点计（连续标点算一句）
  const sentences = countMatches(text, /[。！？.!?]+/g);

  // UTF-8 字节数
  const bytes = new Blob([text]).size;

  // 数字串数：连续数字段
  const digits = countMatches(text, /[0-9]+/g);

  // 标点数：中文标点（全角符号区 U+3001–U+303F、U+FF00–U+FFEF，排除 U+3000 全角空格）+ 通用标点（破折号 U+2014、间隔号 U+00B7、省略号 U+2026）+ ASCII 常见标点
  const punctuation = countMatches(text, /[、-〿＀-￯—·…]|[.,!?;:'"()\[\]{}\-]/g);

  // 英文字母数
  const letters = countMatches(text, /[A-Za-z]/g);

  return {
    charsWithSpaces,
    charsNoSpaces,
    words,
    lines,
    nonEmptyLines,
    paragraphs,
    sentences,
    bytes,
    digits,
    punctuation,
    letters,
  };
}
