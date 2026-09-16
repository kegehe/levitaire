import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { clearMockListeners, emitMockEvent, mockHide } from "../test/tauri-mock";
import UpdatePrompt from "./UpdatePrompt";
import type { UpdateSnapshot } from "../hooks/useUpdater";

const mockInvoke = vi.mocked(invoke);

/** 构造后端快照（`updater/mod.rs::UpdateStatus`） */
function snapshot(partial: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    version: "0.1.6",
    notes: "",
    phase: "idle",
    received: 0,
    total: null,
    error: null,
    ...partial,
  };
}

/** 挂载时 `get_update_status` 返回给定快照（窗口是后端 show 的，事件常早于监听器注册） */
function routeStatus(status: UpdateSnapshot) {
  mockInvoke.mockImplementation((command: string) => {
    if (command === "get_update_status") return Promise.resolve(status);
    return Promise.resolve(undefined);
  });
}

describe("更新提示窗（只在安装包就绪时出现）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
  });

  it("已就绪：显示版本与「立即更新」，不收窗口", async () => {
    routeStatus(snapshot({ phase: "ready" }));
    render(<UpdatePrompt />);

    await waitFor(() => expect(screen.getByText("新版本已就绪")).toBeTruthy());
    expect(screen.getByText("Levitaire v0.1.6")).toBeTruthy();
    expect(screen.getByRole("button", { name: /立即更新/ })).toBeTruthy();
    expect(mockHide).not.toHaveBeenCalled();
  });

  it("安装失败：把原因留在窗口里，不得静默消失", async () => {
    // 回归：后端 `fail_install` 会把快照推成 failed（并顺手清掉缓存包）。
    // 此前窗口的「非 ready 就隐藏」规则会让它立刻收回去 —— 用户点了「立即更新」，
    // 窗口一闪而过、什么都没说，本地那条错误文案永远显示不出来。
    routeStatus(snapshot({ phase: "failed", error: "安装包签名校验失败" }));
    render(<UpdatePrompt />);

    await waitFor(() => expect(screen.getByText("更新未完成")).toBeTruthy());
    expect(screen.getByText("安装包签名校验失败")).toBeTruthy();
    expect(mockHide).not.toHaveBeenCalled();
  });

  it("失败态由事件推上来时同样显示原因（不只认挂载时那次快照）", async () => {
    routeStatus(snapshot({ phase: "ready" }));
    render(<UpdatePrompt />);
    await waitFor(() => expect(screen.getByText("新版本已就绪")).toBeTruthy());

    act(() => {
      emitMockEvent(
        "update-status",
        snapshot({ phase: "failed", error: "读取已下载的安装包失败" }),
      );
    });

    expect(screen.getByText("读取已下载的安装包失败")).toBeTruthy();
    expect(mockHide).not.toHaveBeenCalled();
  });

  it("无更新 / 后台下载中：不渲染内容并把窗口收回去", async () => {
    // 窗口是后端 show 的，若前端渲染 null 却不隐藏，就是一个空透明层挡住下面所有点击
    routeStatus(snapshot({ phase: "idle" }));
    render(<UpdatePrompt />);

    await waitFor(() => expect(mockHide).toHaveBeenCalled());
    expect(screen.queryByText("Levitaire v0.1.6")).toBeNull();
  });

  it("失败后点「重新下载」重新走一次后端检查（后端会重新静默下载）", async () => {
    routeStatus(snapshot({ phase: "failed", error: "连接超时" }));
    render(<UpdatePrompt />);
    await waitFor(() => expect(screen.getByText("更新未完成")).toBeTruthy());

    mockInvoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /重新下载/ }));
    });

    expect(mockInvoke).toHaveBeenCalledWith("check_for_updates");
  });
});
