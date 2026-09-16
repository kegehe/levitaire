/**
 * 时间工具内共享的时长格式化：秒 → `mm:ss`，超过 1 小时补上 `h:mm:ss`。
 * 倒计时/秒表/番茄钟三个页签都按同一规则显示，避免各自实现出现口径差异。
 */
export function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
