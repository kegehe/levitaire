import type { DedupMode } from "../constants/dedupConfig";

/**
 * 文本去重纯函数。按 mode.granularity 选择粒度：
 * - "line"：按整行去重（trim 整行作为 key，保留首次出现行的原始格式）
 * - "word"：每行内按词去重（词以空白+常见标点分隔，保留分隔符与首次词的原始格式）
 * - "char"：按字符去重，子模式由 mode.charSubMode 决定
 *   - "all"：逐字去重（跨行，保留首次出现的字符）
 *   - "line"：行内逐字去重（保留换行结构）
 *   - "consecutive"：仅压缩连续重复字符
 *
 * 大小写敏感（A 与 a 视为不同）。
 */
export function dedup(text: string, mode: DedupMode): string {
  switch (mode.granularity) {
    case "line":
      return dedupByLine(text);
    case "word":
      return dedupByWord(text);
    case "char":
      return dedupByChar(text, mode.charSubMode);
    default:
      // 防御：未知的粒度值回退到按行去重
      return dedupByLine(text);
  }
}

// ─── 按行去重 ────────────────────────────────────────────────

function dedupByLine(text: string): string {
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(line);
    }
  }
  return out.join("\n");
}

// ─── 按词去重（行内） ────────────────────────────────────────

// 分隔符 = 空白与常见标点（, ; 、 ， ； |）
// 用捕获组 split 保留分隔符：结果为 [词, 分隔符, 词, 分隔符, ...] 交替，
// 行首若为分隔符则首元素为该分隔符，行首为空串时首元素为 ""。
const WORD_SPLIT_RE = /([\s,;、，；|]+)/;

function dedupByWord(text: string): string {
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => dedupWordsInLine(line));
  return out.join("\n");
}

function dedupWordsInLine(line: string): string {
  const parts = line.split(WORD_SPLIT_RE);
  // parts 下标为偶数的是词片段，奇数的是分隔符片段。
  // 语义：分隔符绑定到其后的词（前缀分隔符）。词被去重丢弃时，其前导分隔符一并丢弃；
  // 词保留时，前导分隔符也保留。这样 a, b, a → a, b（末尾不会残留 ", "），
  // 行首空白 "  a a b" → "  a b"（行首空白绑定首个保留词，得以保留）。
  const seen = new Set<string>();
  const out: string[] = [];
  let pendingSep = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 !== 0) {
      // 分隔符片段：暂存，等待后续词决定去留
      pendingSep += parts[i];
      continue;
    }
    // 词片段
    const word = parts[i];
    const key = word.trim();
    if (key === "") {
      // 空词（行尾空串）：连同前导分隔符原样保留
      out.push(pendingSep);
      pendingSep = "";
      out.push(word);
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(pendingSep);
      pendingSep = "";
      out.push(word);
    } else {
      // 重复词：丢弃词及其前导分隔符
      pendingSep = "";
    }
  }
  // 末尾若仍有未绑定词的 pendingSep（纯分隔符行），原样保留
  out.push(pendingSep);
  return out.join("");
}

// ─── 按字符去重 ──────────────────────────────────────────────

function dedupByChar(text: string, subMode: DedupMode["charSubMode"]): string {
  switch (subMode) {
    case "all":
      return dedupCharsAll(text);
    case "line":
      return dedupCharsByLine(text);
    case "consecutive":
      return dedupConsecutive(text);
    default:
      // 防御：未知的子模式回退到逐字去重
      return dedupCharsAll(text);
  }
}

/** 逐字去重（跨行）：保留首次出现的字符 */
function dedupCharsAll(text: string): string {
  const chars = Array.from(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of chars) {
    if (!seen.has(ch)) {
      seen.add(ch);
      out.push(ch);
    }
  }
  return out.join("");
}

/** 行内逐字去重：保留换行结构 */
function dedupCharsByLine(text: string): string {
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    const seen = new Set<string>();
    const res: string[] = [];
    for (const ch of Array.from(line)) {
      if (!seen.has(ch)) {
        seen.add(ch);
        res.push(ch);
      }
    }
    return res.join("");
  });
  return out.join("\n");
}

/** 仅压缩连续重复字符：相邻相同字符只保留一个 */
function dedupConsecutive(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (out.length === 0 || out[out.length - 1] !== ch) {
      out.push(ch);
    }
  }
  return out.join("");
}
