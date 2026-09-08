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
});
