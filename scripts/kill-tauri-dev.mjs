import { execFileSync } from "child_process";

// The single-instance Tauri plugin hands a second launch to the existing app.
// Stop it before starting dev so the current Rust binary and Vite server own every window.
if (process.platform === "win32") {
  try {
    execFileSync("taskkill", ["/IM", "floatory.exe", "/F"], {
      stdio: "ignore",
    });
    console.log("Stopped existing Floatory instance");
  } catch {
    // No existing Floatory instance is running.
  }
}
