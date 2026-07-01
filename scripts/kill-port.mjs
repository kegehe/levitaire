import { execSync } from "child_process";

const port = 1420;

try {
  if (process.platform === "win32") {
    const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = output.trim().split(/\s+/).pop();
    if (pid && pid !== "0") {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      console.log(`Killed process ${pid} on port ${port}`);
    }
  } else {
    execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: "ignore" });
    console.log(`Killed process on port ${port}`);
  }
} catch {
  // Port not in use, nothing to kill
}
