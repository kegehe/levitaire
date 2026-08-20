import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/// <reference types="vitest" />
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      // 禁止 Vite 访问 src-tauri 目录，避免扫描 Rust 编译产物导致 EMFILE
      deny: ["**/src-tauri/**"],
    },
  },
  optimizeDeps: {
    // 显式指定入口，避免 Vite 用 **/*.html glob 扫描到 src-tauri/target/doc/ 下的 Rust 文档 HTML 导致 EMFILE
    entries: ["index.html"],
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 稳定的 vendor chunk，避免每个窗口/工具 chunk 内联 React
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
            return "react-vendor";
          }
        },
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
