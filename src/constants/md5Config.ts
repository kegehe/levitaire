import { invoke } from "@tauri-apps/api/core";

/** MD5 输出位数 */
export type Md5Length = "32" | "16";

/** 默认 MD5 位数：32 位（标准 hex 输出） */
export const DEFAULT_MD5_LENGTH: Md5Length = "32";

const MD5_LENGTH_SET: ReadonlySet<Md5Length> = new Set(["32", "16"]);

/** 判定并归一化存储中的 MD5 位数配置，脏数据回退到默认值 */
function normalize(raw: unknown): Md5Length {
  if (typeof raw === "string" && MD5_LENGTH_SET.has(raw as Md5Length)) {
    return raw as Md5Length;
  }
  return DEFAULT_MD5_LENGTH;
}

/**
 * 从后端配置加载 MD5 位数。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 */
export async function fetchMd5Length(): Promise<Md5Length> {
  try {
    const stored = await invoke<string>("get_md5_length");
    if (stored) {
      return normalize(stored);
    }
  } catch {
    // fallthrough
  }
  return DEFAULT_MD5_LENGTH;
}

/** 保存 MD5 位数配置到后端 */
export async function saveMd5Length(length: Md5Length): Promise<void> {
  await invoke("set_md5_length", { length });
}

/** MD5 位数选项（供设置页下拉渲染） */
export const MD5_LENGTH_OPTIONS: ReadonlyArray<{
  value: Md5Length;
  label: string;
}> = [
  { value: "32", label: "32 位（标准）" },
  { value: "16", label: "16 位（截断）" },
];
