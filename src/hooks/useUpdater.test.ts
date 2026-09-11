import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { useUpdater } from "./useUpdater";
import { emitMockEvent, clearMockListeners } from "../test/tauri-mock";

// 只暴露 check：useUpdater 不应再走 JS 插件的 downloadAndInstall（那条路径没有
// 读空闲超时，96MB 包卡住时会永久等待）。若实现回退到它，本测试会直接抛错。
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

const mockCheck = vi.mocked(check);
const mockInvoke = vi.mocked(invoke);

/** 检查结果里的 Update 对象在测试中只需 version */
function fakeUpdate(version = "0.1.5") {
  return { version } as unknown as Awaited<ReturnType<typeof check>>;
}

describe("useUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
  });

  it("检查更新时显式带上超时，避免代理不可用时无限转圈", async () => {
    mockCheck.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(mockCheck).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(result.current.status).toBe("upToDate");
  });

  it("检查到新版本进入 available 并记录版本号", async () => {
    mockCheck.mockResolvedValue(fakeUpdate("0.1.5"));
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.status).toBe("available");
    expect(result.current.availableVersion).toBe("0.1.5");
  });

  it("检查失败进入 error 并给出错误信息", async () => {
    mockCheck.mockRejectedValue("network down");
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("network down");
  });

  it("下载安装走后端 install_update（而非 JS 插件路径）", async () => {
    mockCheck.mockResolvedValue(fakeUpdate());
    mockInvoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(mockInvoke).toHaveBeenCalledWith("install_update");
    expect(result.current.status).toBe("installing");
    expect(result.current.progress).toBe(100);
  });

  it("进度取自后端 update-progress 事件并按累计字节换算百分比", async () => {
    mockCheck.mockResolvedValue(fakeUpdate());
    // install_update 挂起，模拟仍在下载
    mockInvoke.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      void result.current.downloadAndInstall();
    });
    expect(result.current.status).toBe("downloading");

    act(() => {
      emitMockEvent("update-progress", { received: 24_000_000, total: 96_000_000 });
    });
    expect(result.current.progress).toBe(25);

    act(() => {
      emitMockEvent("update-progress", { received: 96_000_000, total: 96_000_000 });
    });
    expect(result.current.progress).toBe(100);
  });

  it("下载失败进入 error 而不是卡在 downloading", async () => {
    mockCheck.mockResolvedValue(fakeUpdate());
    mockInvoke.mockRejectedValue("下载失败: 连接超时");
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("下载失败: 连接超时");
  });

  it("reset 复位到初始态", async () => {
    mockCheck.mockResolvedValue(fakeUpdate());
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate();
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.availableVersion).toBeNull();
    expect(result.current.progress).toBeNull();
  });
});
