import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 后端 `updater/mod.rs` 的 `UpdateStatus` 快照（字段同名直传，无大小写转换）。
 *
 * 下载由后端在后台自己发起，可能远早于设置页打开，所以状态只能靠「快照 + 事件」
 * 同步 —— 不能像旧实现那样只看「本页发起的那次检查」的返回值。
 */
export interface UpdateSnapshot {
  /** 目标版本号（检测到新版本后即有值） */
  version: string | null;
  notes: string;
  phase: "idle" | "downloading" | "ready" | "failed";
  received: number;
  total: number | null;
  error: string | null;
}

/**
 * 在线更新状态机（前端视图态）：
 *   idle        初始 / 无待处理更新（设置页显示「检查更新」按钮）
 *   checking    正在联网检查
 *   upToDate    已是最新版本
 *   downloading 后端正在静默下载安装包（progress 记录百分比）
 *   ready       安装包已下载完成，点击即可安装
 *   installing  正在安装（安装器接管后应用会退出重启）
 *   error       检查 / 下载 / 安装失败
 */
export type UpdaterStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UseUpdaterReturn {
  status: UpdaterStatus;
  /** 正在下载 / 已就绪的版本号（downloading、ready 状态下有值） */
  availableVersion: string | null;
  /** 下载进度百分比 0~100（总量未知时为 null，UI 显示「下载中…」） */
  progress: number | null;
  errorMessage: string | null;
  /** 手动检查是否有新版本；发现新版本会由后端接着静默下载 */
  checkForUpdate: () => Promise<void>;
  /** 安装已下载完成的更新包（不再走一次下载） */
  installUpdate: () => Promise<void>;
}

/** 已接收 / 总量 → 百分比；总量未知时为 null（UI 显示「下载中…」） */
export function updateProgressPercent(received: number, total: number | null): number | null {
  return total != null && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
}

export function useUpdater(): UseUpdaterReturn {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 竞态防护：每次 check/install 推进序号，过期异步结果直接丢弃，
  // 避免快速连续点击时乱序返回覆盖最新状态。
  const generationRef = useRef(0);

  /**
   * 后端快照 → 本地视图态。
   *
   * `idleAsUpToDate` 只给「刚手动检查完」用：后台周期检查发现没有更新时同样会把
   * 状态推成 idle，那种情况下不该把「检查更新」按钮换掉（用户并没有主动问）。
   */
  const applySnapshot = useCallback((snapshot: UpdateSnapshot, idleAsUpToDate: boolean) => {
    setAvailableVersion(snapshot.version);
    switch (snapshot.phase) {
      case "downloading":
        setProgress(updateProgressPercent(snapshot.received, snapshot.total));
        setErrorMessage(null);
        setStatus("downloading");
        break;
      case "ready":
        setProgress(100);
        setErrorMessage(null);
        setStatus("ready");
        break;
      case "failed":
        setProgress(null);
        setErrorMessage(snapshot.error ?? "更新失败");
        setStatus("error");
        break;
      default:
        setProgress(null);
        setErrorMessage(null);
        setStatus(idleAsUpToDate ? "upToDate" : "idle");
    }
  }, []);

  // 挂载时先拉一次快照：静默下载是后端发起的，进设置页时可能已经在下载或已就绪，
  // 光等事件会一直显示「检查更新」按钮。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // 这份快照是「挂载那一刻」的本地状态，有两条路径会让它变旧：
    //   ① 事件先到（后端状态已经推进过）；
    //   ② 用户在本页手动点了检查/安装（序号已推进）。
    // 两种情况都不该回填，否则会把更新的状态打回去。
    const generationAtMount = generationRef.current;
    let sawEvent = false;
    const init = async () => {
      // 两者并发注册，且都要等到 —— 否则组件在 `await listen()` 期间卸载时
      // `unlisten` 还没赋值，清理函数拿到 undefined，监听器会永久残留。
      const [un, snapshot] = await Promise.all([
        listen<UpdateSnapshot>("update-status", (event) => {
          sawEvent = true;
          applySnapshot(event.payload, false);
        }),
        invoke<UpdateSnapshot>("get_update_status"),
      ]);
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      if (!sawEvent && generationRef.current === generationAtMount) {
        applySnapshot(snapshot, false);
      }
    };
    init().catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applySnapshot]);

  const checkForUpdate = useCallback(async () => {
    const gen = ++generationRef.current;
    setStatus("checking");
    setProgress(null);
    setErrorMessage(null);
    try {
      // 检查走后端 `check_for_updates`（不再用 JS 插件的 check）：它复用带连接超时与
      // 读空闲超时的客户端，并在发现新版本时直接进入静默下载流程。
      const snapshot = await invoke<UpdateSnapshot>("check_for_updates");
      if (gen !== generationRef.current) return;
      applySnapshot(snapshot, true);
    } catch (err) {
      if (gen !== generationRef.current) return;
      console.error("Updater check failed:", err);
      setAvailableVersion(null);
      setErrorMessage(typeof err === "string" ? err : String(err));
      setStatus("error");
    }
  }, [applySnapshot]);

  const installUpdate = useCallback(async () => {
    const gen = ++generationRef.current;
    setStatus("installing");
    setErrorMessage(null);
    try {
      // 安装的是后端已经下好并验签过的本地包，点击后立刻开始装，不会再去下一遍。
      await invoke("install_update");
      if (gen !== generationRef.current) return;
      // install_update 成功后应用自身会退出重启，此处无需再操作
      setProgress(100);
      setStatus("installing");
    } catch (err) {
      if (gen !== generationRef.current) return;
      console.error("Updater install failed:", err);
      setErrorMessage(typeof err === "string" ? err : String(err));
      setStatus("error");
    }
  }, []);

  return {
    status,
    availableVersion,
    progress,
    errorMessage,
    checkForUpdate,
    installUpdate,
  };
}
