import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * 将当前悬浮窗的位置持久化到后端配置，应用重启后恢复到上次位置。
 * 由各悬浮窗在拖动结束后调用；后端 set_window_position 命令负责写入 config.json。
 */
export async function saveWindowPosition(windowId: string): Promise<void> {
  try {
    const pos = await getCurrentWebviewWindow().outerPosition();
    await invoke("set_window_position", { id: windowId, x: pos.x, y: pos.y });
  } catch (err) {
    console.error(`保存窗口位置失败 (${windowId}):`, err);
  }
}

/**
 * 订阅当前窗口的移动事件，在拖动结束后（静置 300ms）保存位置。
 * 返回清理函数，组件卸载时调用。
 */
export function persistWindowPositionOnMove(windowId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unlisten: (() => void) | undefined;
  let disposed = false;

  try {
    getCurrentWebviewWindow()
      .onMoved(() => {
        if (disposed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void saveWindowPosition(windowId);
        }, 300);
      })
      .then((fn) => {
        // 若组件在注册完成前已卸载，立即取消刚拿到的监听器，避免泄漏
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(console.error);
  } catch (err) {
    // 某些环境（如测试）可能未提供 onMoved，不影响窗口其他功能
    console.error(`监听窗口移动失败 (${windowId}):`, err);
  }

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (unlisten) unlisten();
  };
}
