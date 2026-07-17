import { execFileSync } from "child_process";

// The single-instance Tauri plugin hands a second launch to the existing app.
// Stop it before starting dev so the current Rust binary and Vite server own every window.
if (process.platform === "win32") {
  try {
    execFileSync("taskkill", ["/IM", "floast-service.exe", "/F"], {
      stdio: "ignore",
    });
    console.log("Stopped existing Floast instance");
  } catch {
    // No existing Floast instance is running.
  }
}
