import { useState, useCallback, useRef } from "react";
import {
  check,
  type Update,
  type DownloadEvent,
} from "@tauri-apps/plugin-updater";

/**
 * 在线更新状态机：
 *   idle       初始 / 复位
 *   checking    正在联网检查最新版本
 *   upToDate    已是最新版本（无可用更新）
 *   available   检测到新版本（等待用户确认下载）
 *   downloading 正在下载安装包（progress 记录进度）
 *   installing  正在执行安装（安装器随后接管并重启应用）
 *   error       检查/下载/安装失败
 */
export type UpdaterStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface UseUpdaterReturn {
  status: UpdaterStatus;
  /** 可用新版本的版本号（available 状态下有值） */
  availableVersion: string | null;
  /** 下载进度百分比 0~100（downloading 状态下有值，未知总量时为 null） */
  progress: number | null;
  errorMessage: string | null;
  /** 检查是否有新版本 */
  checkForUpdate: () => Promise<void>;
  /** 下载并安装检测到的新版本 */
  downloadAndInstall: () => Promise<void>;
  /** 复位到初始态 */
  reset: () => void;
}

export function useUpdater(): UseUpdaterReturn {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 竞态防护：每次 check/download 推进序号，过期异步结果直接丢弃，
  // 避免快速连续点击时乱序返回覆盖最新状态。
  const generationRef = useRef(0);
  // 保存待安装的 Update 对象（检查成功且未消费时保留，供下载/安装使用）
  const pendingUpdateRef = useRef<Update | null>(null);

  const checkForUpdate = useCallback(async () => {
    const gen = ++generationRef.current;
    setStatus("checking");
    setProgress(null);
    setErrorMessage(null);
    try {
      // dev 模式（npm run tauri dev）下发布用插件未初始化，check() 会抛错，
      // 此处捕获后按“无更新”处理，保证开发时设置页可正常打开。
      const update = await check();
      if (gen !== generationRef.current) return;
      if (update) {
        pendingUpdateRef.current = update;
        setAvailableVersion(update.version);
        setStatus("available");
      } else {
        pendingUpdateRef.current = null;
        setAvailableVersion(null);
        setStatus("upToDate");
      }
    } catch (err) {
      if (gen !== generationRef.current) return;
      console.error("Updater check failed:", err);
      pendingUpdateRef.current = null;
      setAvailableVersion(null);
      setErrorMessage(typeof err === "string" ? err : String(err));
      setStatus("error");
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update) return;
    const gen = ++generationRef.current;
    setStatus("downloading");
    setProgress(0);
    setErrorMessage(null);
    let received = 0;
    let total: number | null = null;
    const onEvent = (e: DownloadEvent) => {
      if (gen !== generationRef.current) return;
      if (e.event === "Started") {
        total = e.data.contentLength ?? null;
      } else if (e.event === "Progress") {
        received += e.data.chunkLength;
        // 总量可获取时按已接收字节数算百分比；总量未知则显示“下载中”
        setProgress(total != null && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null);
      }
    };
    try {
      await update.downloadAndInstall(onEvent);
      if (gen !== generationRef.current) return;
      // 安装结束后安装器接管并引导重启（passive 模式自动安装）；
      // 进入 installing 态仅作 UI 收尾提示，进程随后会被安装器关闭。
      setProgress(100);
      setStatus("installing");
      pendingUpdateRef.current = null;
    } catch (err) {
      if (gen !== generationRef.current) return;
      console.error("Updater download/install failed:", err);
      setErrorMessage(typeof err === "string" ? err : String(err));
      setStatus("error");
    }
  }, []);

  const reset = useCallback(() => {
    generationRef.current++;
    pendingUpdateRef.current = null;
    setStatus("idle");
    setAvailableVersion(null);
    setProgress(null);
    setErrorMessage(null);
  }, []);

  return {
    status,
    availableVersion,
    progress,
    errorMessage,
    checkForUpdate,
    downloadAndInstall,
    reset,
  };
}
