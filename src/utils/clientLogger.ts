import { invoke } from "@tauri-apps/api/core";

let installed = false;

function serialize(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Forward uncaught WebView errors to the native rolling log. */
export function installClientLogger(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    void invoke("write_client_log", {
      tag: "uncaught-error",
      message: `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    }).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (event) => {
    void invoke("write_client_log", {
      tag: "unhandled-rejection",
      message: serialize(event.reason),
    }).catch(() => {});
  });
}
