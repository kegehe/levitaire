import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UtilityHub from "./UtilityHub";
import { clearMockListeners, emitMockEvent } from "../../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);

describe("UtilityHub", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.removeItem("levitaire-utility-recent-colors");
    mockInvoke.mockImplementation((command) => {
      if (command === "get_scroll_navigation_state") {
        return Promise.resolve({ precise: false, percent: null, fallbackAvailable: true });
      }
      return Promise.resolve(undefined);
    });
  });

  it("shows the small-tool row and opens scroll navigation in place", async () => {
    render(<UtilityHub />);
    expect(screen.getByRole("button", { name: /取色/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /滚动/ }));
    expect(screen.getByRole("button", { name: /滚动/ })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "到达顶部" })).toBeEnabled();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_scroll_navigation_state"));
  });

  it("reserves native window space above the compact content for tooltips", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 36,
    } as DOMRect);

    render(<UtilityHub />);

    expect(document.body).toHaveClass("utility-hub-window");

    const window = (await import("@tauri-apps/api/webviewWindow")).getCurrentWebviewWindow();
    await waitFor(() => {
      expect(window.setSize).toHaveBeenCalledWith(
        expect.objectContaining({ width: 120, height: 62 }),
      );
    });
  });

  it("starts native color sampling and displays its returned pixel", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_utility_color_pick"));
    expect(screen.getByRole("button", { name: /取色/ }).querySelector("svg")).toHaveClass(
      "lucide-pipette",
    );

    emitMockEvent("utility-color-picked", "#123ABC");
    expect(await screen.findByDisplayValue("#123ABC")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("show_utility_hub");
  });

  it("keeps native sampling armed for repeated color picks", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_utility_color_pick"));

    emitMockEvent("utility-color-picked", "#123ABC");
    emitMockEvent("utility-color-picked", "#FEDCBA");

    expect(await screen.findByDisplayValue("#FEDCBA")).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("stop_utility_color_pick");
  });

  it("stops sampling through the native cleanup paths when switching tools or closing", () => {
    render(<UtilityHub />);

    fireEvent.click(screen.getByRole("button", { name: /滚动/ }));
    expect(mockInvoke).toHaveBeenCalledWith("stop_utility_color_pick");

    fireEvent.click(screen.getByRole("button", { name: /关闭/ }));
    expect(mockInvoke).toHaveBeenCalledWith("hide_utility_hub");
  });

  it("shows the picked color as rgb and copies that value", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    emitMockEvent("utility-color-picked", "#123ABC");
    await screen.findByDisplayValue("#123ABC");

    const rgbButton = screen.getByRole("button", { name: "复制 RGB 值" });
    expect(rgbButton).toHaveTextContent("rgb(18, 58, 188)");

    fireEvent.click(rgbButton);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("copy_text", { text: "rgb(18, 58, 188)" }),
    );
  });

  it("persists picked colors so the history survives a remount", async () => {
    const first = render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    emitMockEvent("utility-color-picked", "#123ABC");
    await screen.findByDisplayValue("#123ABC");

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("levitaire-utility-recent-colors") ?? "null")).toEqual(
        ["#123ABC"],
      );
    });
    first.unmount();

    // 重挂载后历史仍在，切到取色面板即可看到色块
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    expect(await screen.findByRole("button", { name: "选择 #123ABC" })).toBeInTheDocument();
  });

  it("ignores a corrupted color history instead of crashing", () => {
    localStorage.setItem("levitaire-utility-recent-colors", "{not json");
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    expect(screen.queryByRole("button", { name: /^选择 #/ })).toBeNull();
  });
});
