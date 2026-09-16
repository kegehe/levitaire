import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { invoke } from "@tauri-apps/api/core";
import { useUpdater, type UpdateSnapshot } from "./useUpdater";
import { emitMockEvent, clearMockListeners } from "../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);

/** 构造后端快照（`updater/mod.rs::UpdateStatus`） */
function snapshot(partial: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    version: null,
    notes: "",
    phase: "idle",
    received: 0,
    total: null,
    error: null,
    ...partial,
  };
}

type Routes = {
  /** `get_update_status`：挂载时的兜底快照 */
  status?: UpdateSnapshot;
  /** `check_for_updates`：手动检查的结果，抛错表示检查失败 */
  check?: UpdateSnapshot | Error;
  /** `install_update`：抛错表示安装失败 */
  install?: Error;
};

/** 按命令名分发 invoke（挂载时 hook 会先查一次快照） */
function routeInvoke({ status, check, install }: Routes = {}) {
  mockInvoke.mockImplementation((command: string) => {
    switch (command) {
      case "get_update_status":
        return Promise.resolve(status ?? snapshot());
      case "check_for_updates":
        return check instanceof Error ? Promise.reject(check.message) : Promise.resolve(check ?? snapshot());
      case "install_update":
        return install instanceof Error ? Promise.reject(install.message) : Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
}

describe("useUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    routeInvoke();
  });

  it("挂载时先读一次后端快照：静默下载可能早已开始，不能只等事件", async () => {
    routeInvoke({
      status: snapshot({ version: "0.1.6", phase: "downloading", received: 24_000_000, total: 96_000_000 }),
    });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    expect(mockInvoke).toHaveBeenCalledWith("get_update_status");
    expect(result.current.status).toBe("downloading");
    expect(result.current.availableVersion).toBe("0.1.6");
    expect(result.current.progress).toBe(25);
  });

  it("挂载时若已下载完成则直接进入 ready", async () => {
    routeInvoke({ status: snapshot({ version: "0.1.6", phase: "ready" }) });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    expect(result.current.status).toBe("ready");
    expect(result.current.progress).toBe(100);
  });

  it("后端状态事件驱动 UI，无需本页发起检查", async () => {
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    act(() => {
      emitMockEvent("update-status", snapshot({ version: "0.1.6", phase: "downloading", received: 0, total: null }));
    });
    expect(result.current.status).toBe("downloading");
    // 总量未知时不给百分比，UI 显示「下载中…」
    expect(result.current.progress).toBeNull();

    act(() => {
      emitMockEvent("update-status", snapshot({ version: "0.1.6", phase: "ready" }));
    });
    expect(result.current.status).toBe("ready");
  });

  it("迟到的初始快照不得覆盖挂载期间已到达的事件", async () => {
    // invoke 挂起以模拟慢往返；期间后端推来一条更新的状态（downloading → ready）
    let resolveStatus: (value: UpdateSnapshot) => void = () => {};
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_update_status") {
        return new Promise<UpdateSnapshot>((resolve) => {
          resolveStatus = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    act(() => {
      emitMockEvent("update-status", snapshot({ version: "0.1.6", phase: "ready" }));
    });
    expect(result.current.status).toBe("ready");

    // 现在才回来的那份快照是更早的状态，不能把 UI 打回 downloading
    await act(async () => {
      resolveStatus(snapshot({ version: "0.1.6", phase: "downloading", received: 1, total: 100 }));
    });
    expect(result.current.status).toBe("ready");
  });

  it("手动检查走后端 check_for_updates，无更新进入 upToDate", async () => {
    routeInvoke({ check: snapshot() });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(mockInvoke).toHaveBeenCalledWith("check_for_updates");
    expect(result.current.status).toBe("upToDate");
  });

  it("手动检查发现新版本：后端直接进入静默下载", async () => {
    routeInvoke({
      check: snapshot({ version: "0.1.6", phase: "downloading", received: 9_600_000, total: 96_000_000 }),
    });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.status).toBe("downloading");
    expect(result.current.availableVersion).toBe("0.1.6");
    expect(result.current.progress).toBe(10);
  });

  it("手动检查发起后，迟到的初始快照不得覆盖检查结果", async () => {
    // 挂载时的 get_update_status 一直挂着，先让用户点一次「检查更新」
    let resolveStatus: (value: UpdateSnapshot) => void = () => {};
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_update_status") {
        return new Promise<UpdateSnapshot>((resolve) => {
          resolveStatus = resolve;
        });
      }
      if (command === "check_for_updates") {
        return Promise.resolve(
          snapshot({ version: "0.1.6", phase: "downloading", received: 1, total: 100 }),
        );
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    await act(async () => {
      await result.current.checkForUpdate();
    });
    expect(result.current.status).toBe("downloading");

    // 现在才回来的那份「挂载时快照」（idle）不能把刚拿到的结果打回去
    await act(async () => {
      resolveStatus(snapshot());
    });
    expect(result.current.status).toBe("downloading");
    expect(result.current.availableVersion).toBe("0.1.6");
  });

  it("检查失败进入 error 并给出错误信息", async () => {
    routeInvoke({ check: new Error("network down") });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("network down");
  });

  it("下载失败（后端状态为 failed）显示错误而不是卡在 downloading", async () => {
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    act(() => {
      emitMockEvent(
        "update-status",
        snapshot({ version: "0.1.6", phase: "failed", error: "下载失败: 连接超时" }),
      );
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("下载失败: 连接超时");
  });

  it("安装走 backend install_update（本地缓存包，不再下载）", async () => {
    routeInvoke({ install: undefined });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(mockInvoke).toHaveBeenCalledWith("install_update");
    expect(result.current.status).toBe("installing");
  });

  it("安装失败进入 error 而不是卡在 installing", async () => {
    routeInvoke({ install: new Error("安装包签名校验失败") });
    const { result } = renderHook(() => useUpdater());
    await act(async () => {});

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("安装包签名校验失败");
  });
});

/**
 * 源码级守卫：前端不得再走 JS 插件的更新入口。
 *
 * `@tauri-apps/plugin-updater` 的 `check()` / `downloadAndInstall()` 只暴露整体
 * timeout，对 96MB 安装包会在慢速链路上误杀下载；后端那条路径注入了连接超时 +
 * 读空闲超时兜底，且静默下载的进度/状态都要走它。一旦有人把 JS 插件引回来，
 * 行为差异不会体现在任何一例 UI 测试里（mock 掉之后长得一模一样），只能靠读源码拦。
 */
describe("更新入口必须统一走后端命令", () => {
  const files = [
    "src/hooks/useUpdater.ts",
    "src/components/UpdatePrompt.tsx",
    "src/components/ContextMenu.tsx",
  ];

  function read(rel: string): string {
    return readFileSync(fileURLToPath(new NodeURL(`../../${rel}`, import.meta.url)), "utf8");
  }

  it("不再引用 @tauri-apps/plugin-updater", () => {
    for (const rel of files) {
      expect(read(rel), `${rel} 又用回了 JS 插件 updater`).not.toContain(
        "@tauri-apps/plugin-updater",
      );
    }
  });

  it("调用的是后端三组命令 + 状态事件（防止命令名/事件名漂移）", () => {
    const hook = read("src/hooks/useUpdater.ts");
    for (const command of ["get_update_status", "check_for_updates", "install_update"]) {
      expect(hook, `useUpdater 未调用后端命令 ${command}`).toContain(command);
    }
    // 事件名与后端 publish() 的 emit 名必须一致（旧实现是 update-available / update-progress）
    for (const rel of files) {
      expect(read(rel), `${rel} 未订阅 update-status`).toContain('"update-status"');
    }
    // 托盘菜单只读快照、显式检查才联网
    expect(read("src/components/ContextMenu.tsx")).toContain('"get_update_status"');
  });
});
