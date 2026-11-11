import { execFileSync } from "child_process";

const port = 1420;

try {
  if (process.platform === "win32") {
    // netstat 不会列出仅绑定在 ::1 上的套接字（本机表现为 State 为空 / Bound），
    // 而 Vite 默认就绑 ::1，所以这里改用 Get-NetTCPConnection 才能看到这类占位。
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 } | Select-Object -ExpandProperty OwningProcess -Unique`,
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const pids = new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((pid) => pid && pid !== "0"),
    );
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
        console.log(`Killed process ${pid} on port ${port}`);
      } catch {
        // 进程已退出或无法结束，继续处理其余 PID
      }
    }
  } else {
    execFileSync("sh", ["-c", `lsof -ti:${port} | xargs kill -9`], { stdio: "ignore" });
    console.log(`Killed process on port ${port}`);
  }
} catch {
  // Port not in use, nothing to kill
}
