import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ScrollNavigator from "./ScrollNavigator";

const mockInvoke = vi.mocked(invoke);

const preciseState = { precise: true, percent: 42, fallbackAvailable: true };
const fallbackState = { precise: false, percent: null, fallbackAvailable: true };

describe("ScrollNavigator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_scroll_navigation_state") return Promise.resolve(preciseState);
      return Promise.resolve(preciseState);
    });
  });

  it("renders the precise position and sends preset commands", async () => {
    render(<ScrollNavigator />);
    expect(await screen.findByText("42%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_scroll_navigation_percent", { percent: 50 }),
    );
  });

  it("commits a slider value on pointer release", async () => {
    render(<ScrollNavigator />);
    const slider = await screen.findByRole("slider", { name: "滚动位置" });

    fireEvent.change(slider, { target: { value: "75" } });
    fireEvent.pointerUp(slider);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_scroll_navigation_percent", { percent: 75 }),
    );
  });

  it("keeps keyboard fallback controls available and disables percentages", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_scroll_navigation_state") return Promise.resolve(fallbackState);
      if (command === "navigate_scroll") return Promise.resolve(fallbackState);
      return Promise.resolve(undefined);
    });
    render(<ScrollNavigator />);

    const top = await screen.findByRole("button", { name: "到达顶部" });
    expect(top).toBeEnabled();
    expect(screen.getByRole("slider", { name: "滚动位置" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "滚动百分比" })).toBeDisabled();

    fireEvent.click(top);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("navigate_scroll", { action: "top" }),
    );
  });
});
