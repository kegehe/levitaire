import { useState, useCallback, useRef } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

/**
 * 检查清单的超时。清单只是一个小 JSON，15s 足够；
 * 若系统代理未生效，请求会既连不上也等不到响应，没有超时就会无限停在“正在检查…”。
 */
const CHECK_TIMEOUT_MS = 15_000;

/** 后端 `update-progress` 事件负载（与 updater/mod.rs 的 emit 保持一致） */
interface UpdateProgressPayload {
  received: number;
  total: number | null;
}

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

  const checkForUpdate = useCallback(async () => {
    const gen = ++generationRef.current;
    setStatus("checking");
    setProgress(null);
    setErrorMessage(null);
    try {
      // dev 模式（npm run tauri dev）下发布用插件未初始化，check() 会抛错，
      // 此处捕获后按“无更新”处理，保证开发时设置页可正常打开。
      // 显式带超时：系统代理未生效时既能连不上也可能等不到响应，没有超时会无限转圈。
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (gen !== generationRef.current) return;
      if (update) {
        setAvailableVersion(update.version);
        setStatus("available");
      } else {
        setAvailableVersion(null);
        setStatus("upToDate");
      }
    } catch (err) {
      if (gen !== generationRef.current) return;
      console.error("Updater check failed:", err);
      setAvailableVersion(null);
      setErrorMessage(typeof err === "string" ? err : String(err));
      setStatus("error");
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const gen = ++generationRef.current;
    setStatus("downloading");
    setProgress(0);
    setErrorMessage(null);
    // 下载/安装统一走后端 `install_update`（与右上角自动提示窗同一条路径）：
    // 它经 configure_client 注入了连接超时与读空闲超时，下载卡住时能失败返回；
    // 而 JS 插件路径只暴露整体 timeout，对 96MB 安装包用整体超时会在慢速链路上误杀下载。
    // 进度由后端 `update-progress` 事件回报（received 已是累计字节数）。
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<UpdateProgressPayload>("update-progress", (event) => {
        if (gen !== generationRef.current) return;
        const { received, total } = event.payload;
        // 总量可获取时算百分比；总量未知则置 null，UI 显示“下载中”
        setProgress(
          total != null && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
        );
      });
      await invoke("install_update");
      if (gen !== generationRef.current) return;
      // install_update 成功后应用自身会重启；进入 installing 态仅作 UI 收尾提示。
      setProgress(100);
      setStatus("installing");
    } catch (err) {
      if (gen !== generationRef.current) return;
      console.error("Updater download/install failed:", err);
      setErrorMessage(typeof err === "string" ? err : String(err));
      setStatus("error");
    } finally {
      unlisten?.();
    }
  }, []);

  const reset = useCallback(() => {
    generationRef.current++;
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
