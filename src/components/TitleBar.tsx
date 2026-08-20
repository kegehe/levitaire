import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./TitleBar.css";

/**
 * 自绘标题栏：取代 Windows 原生标题栏，使标题栏背景/按钮跟随应用主题与主题色变化。
 *
 * - 整条标题栏为拖拽区：mousedown 时 JS 显式调用 startDragging() 触发系统拖拽，
 *   按钮区单独排除拖拽以保持点击可用；
 * - 最小化/最大化切换/关闭通过 Tauri 窗口命令实现；
 * - 最大化状态监听 tauri://resize 事件，确保还原/最大化按钮图标同步。
 */
export default function TitleBar({ title = "Levitaire 设置" }: { title?: string }) {
  const [maximized, setMaximized] = useState(false);
  const win = useMemo(() => getCurrentWebviewWindow(), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    win.isMaximized().then(setMaximized).catch(() => {});
    const promise = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    promise.then((fn) => {
      // 若组件已卸载则立即取消监听，避免 StrictMode 双调用或快速卸载时泄漏
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [win]);

  const onMinimize = () => win.minimize().catch(console.error);
  const onToggleMaximize = () => win.toggleMaximize().catch(console.error);
  const onClose = () => win.close().catch(console.error);

  // 通过显式 startDragging() 触发系统拖拽，替代 data-tauri-drag-region 属性判定。
  // 属性判定的正确性依赖 WebView2 对拖拽区的命中检测，在窗口首次展示/布局未就绪、
  // 或与全局低级鼠标钩子同时作用时，会间歇性失效导致窗口拖不动。
  // 改为 JS 显式调用（与悬浮球 FloatingOrb 一致），仅响应主键，不再依赖特性判定，更稳定。
  const onTitleBarMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 跳过窗口控制按钮区域，保证最小化/最大化/关闭可正常点击
    if ((event.target as HTMLElement).closest(".titlebar-controls")) return;
    event.preventDefault();
    win.startDragging().catch((err) => console.error("Failed to start dragging:", err));
  };

  return (
    <div className="titlebar" onMouseDown={onTitleBarMouseDown}>
      <span className="titlebar-title">{title}</span>
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn titlebar-minimize"
          onClick={onMinimize}
          aria-label="最小化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="4.5" width="8" height="1" rx="0.5" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-maximize"
          onClick={onToggleMaximize}
          aria-label={maximized ? "还原" : "最大化"}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="3" width="5" height="5" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M3 3 V1.5 H8 V6 H6.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          onClick={onClose}
          aria-label="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
