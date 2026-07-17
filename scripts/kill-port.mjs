import { execFileSync } from "child_process";

const port = 1420;

try {
  if (process.platform === "win32") {
    const output = execFileSync("netstat", ["-ano"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pids = new Set(
      output
        .split(/\r?\n/)
        .filter((line) => line.includes(`:${port}`) && line.includes("LISTENING"))
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => pid && pid !== "0"),
    );
    for (const pid of pids) {
      execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
      console.log(`Killed process ${pid} on port ${port}`);
    }
  } else {
    execFileSync("sh", ["-c", `lsof -ti:${port} | xargs kill -9`], { stdio: "ignore" });
    console.log(`Killed process on port ${port}`);
  }
} catch {
  // Port not in use, nothing to kill
}
