import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 订阅「文件暂存架」开关，返回当前是否启用。
 *
 * 截图工具和长截图控制条都是常驻窗口，只在挂载时读一次开关会一直停在旧值。
 * 这里先订阅广播再读取当前值：订阅建立前的切换由读取兜底，读取返回前的切换
 * 由广播兜底。另外命令响应与事件走不同的 IPC 通道，响应可能晚于广播到达，
 * 因此收到过广播后不再让初始读取覆盖它。
 */
export function useFileShelfEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let changedByEvent = false;
    const apply = (value: boolean) => {
      if (!disposed) setEnabled(value === true);
    };
    void listen<boolean>("file-shelf-enabled-changed", (event) => {
      changedByEvent = true;
      apply(event.payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {})
      .finally(() => {
        if (disposed) return;
        void invoke<boolean>("get_file_shelf_enabled")
          .then((value) => {
            if (!changedByEvent) apply(value);
          })
          .catch(() => {});
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return enabled;
}
