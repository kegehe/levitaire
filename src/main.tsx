import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import "./styles/desktopShell.css";
import { installDesktopShell } from "./utils/desktopShell";
import { installClientLogger } from "./utils/clientLogger";

// 每个窗口都是同一份 index.html 入口：在 React 挂载前先装上桌面外壳守卫，
// 关闭 WebView2 的网页右键菜单 / 浏览器快捷键（细节见 desktopShell.ts）。
installDesktopShell();
installClientLogger();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
