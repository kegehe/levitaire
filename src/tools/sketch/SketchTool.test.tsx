import { fireEvent, render, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor } from "@tauri-apps/api/window";
import { describe, expect, it, vi } from "vitest";
import { scaleStrokes } from "./SketchTool";
import SketchTool from "./SketchTool";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: vi.fn().mockResolvedValue(null) }));

describe("scaleStrokes", () => {
  it("scales points and text metrics when restoring to another viewport", () => {
    const strokes = [{
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      color: "#fff",
      width: 4,
      mode: "text" as const,
      text: "note",
      fontSize: 20,
    }];

    expect(scaleStrokes(strokes, { width: 100, height: 200, dpr: 1 }, { width: 200, height: 400, dpr: 2 })).toEqual([{
      ...strokes[0],
      points: [{ x: 20, y: 40 }, { x: 60, y: 80 }],
      width: 8,
      fontSize: 40,
    }]);
  });

  it("keeps stroke values unchanged when the viewport is unavailable or equal", () => {
    const strokes = [{ points: [{ x: 1, y: 2 }], color: "#fff", width: 2, mode: "pen" as const }];
    expect(scaleStrokes(strokes, undefined, { width: 100, height: 100, dpr: 1 })).toEqual(strokes);
    expect(scaleStrokes(strokes, { width: 100, height: 100, dpr: 1 }, { width: 100, height: 100, dpr: 2 })).toEqual(strokes);
  });
});

describe("SketchTool drawing lifecycle", () => {
  it("keeps the overlay mounted after a normal stroke", () => {
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    fireEvent.pointerDown(canvas!, { clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(canvas!, { clientX: 140, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(canvas!, { clientX: 140, clientY: 120, pointerId: 1 });
    expect(container.querySelector(".sketch-root")).toBeTruthy();
    expect(container.querySelector(".sketch-close")).toBeTruthy();
  });

  it("renders save as an icon-only toolbar action", () => {
    const { container } = render(<SketchTool />);
    const saveButton = container.querySelector<HTMLButtonElement>(".sketch-save")!;
    expect(saveButton).toHaveAttribute("aria-label", "保存草稿");
    expect(saveButton.querySelector("svg")).toBeTruthy();
    expect(saveButton.textContent).toBe("");
  });

  it("shows a tooltip when hovering a toolbar action", () => {
    const { container } = render(<SketchTool />);
    const penButton = container.querySelector<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button")!;
    const tooltipText = penButton.title;
    fireEvent.pointerOver(penButton);
    expect(container.querySelector(".sketch-tooltip")).toHaveTextContent(tooltipText);
    fireEvent.pointerOut(penButton, { relatedTarget: container.querySelector("canvas") });
    expect(container.querySelector(".sketch-tooltip")).toBeNull();
  });

  it("keeps the tooltip while moving across an icon's SVG child", () => {
    const { container } = render(<SketchTool />);
    const penButton = container.querySelector<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button")!;
    const icon = penButton.querySelector("svg")!;
    fireEvent.pointerOver(penButton);
    fireEvent.pointerOut(penButton, { relatedTarget: icon });
    expect(container.querySelector(".sketch-tooltip")).toHaveTextContent("画笔");
    expect(penButton).not.toHaveAttribute("title");
    expect(penButton).toHaveAttribute("data-tooltip", "画笔");
  });

  it("uses a distinct custom cursor for each drawing tool", () => {
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    const toolButtons = container.querySelectorAll<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button");

    expect(canvas.style.cursor).toContain("data:image/svg+xml");
    const penCursor = canvas.style.cursor;

    fireEvent.click(toolButtons[1]);
    expect(canvas.style.cursor).toContain("data:image/svg+xml");
    expect(canvas.style.cursor).not.toBe(penCursor);
    fireEvent.click(toolButtons[6]);
    expect(canvas.style.cursor).toContain("data:image/svg+xml");
  });

  it("changes color without switching away from the active drawing tool", () => {
    const { container } = render(<SketchTool />);
    const toolButtons = container.querySelectorAll<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button");

    fireEvent.click(toolButtons[1]);
    const lineCursor = container.querySelector("canvas")!.getAttribute("style");
    const colorIndicator = container.querySelector<HTMLSpanElement>(".sketch-color-trigger span")!;
    const initialColor = colorIndicator.style.backgroundColor;
    fireEvent.click(container.querySelector<HTMLButtonElement>(".sketch-color-trigger")!);
    const colors = container.querySelectorAll<HTMLButtonElement>(".sketch-color");

    expect(colors).toHaveLength(7);
    expect(colors[0]).toHaveAttribute("data-selected", "true");
    fireEvent.pointerDown(colors[2]);

    expect(toolButtons[1].className).toContain("active");
    expect(toolButtons[0].className).not.toContain("active");
    expect(container.querySelector(".sketch-picker-panel")).toBeNull();
    expect(colorIndicator.style.backgroundColor).not.toBe(initialColor);
    expect(container.querySelector("canvas")!.getAttribute("style")).not.toBe(lineCursor);
  });

  it("opens compact secondary pickers and closes them with Escape", () => {
    const { container } = render(<SketchTool />);
    const colorTrigger = container.querySelector<HTMLButtonElement>(".sketch-color-trigger")!;
    const widthTrigger = container.querySelector<HTMLButtonElement>(".sketch-width-trigger")!;

    expect(container.querySelector(".sketch-picker-panel")).toBeNull();
    fireEvent.click(colorTrigger);
    expect(colorTrigger).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".sketch-picker-colors")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sketch-picker-panel")).toBeNull();

    fireEvent.click(widthTrigger);
    expect(container.querySelectorAll(".sketch-picker-widths .sketch-width")).toHaveLength(4);
    fireEvent.pointerDown(container.querySelectorAll<HTMLButtonElement>(".sketch-picker-widths .sketch-width")[3]);
    expect(container.querySelector(".sketch-picker-panel")).toBeNull();
    expect(container.querySelector<HTMLSpanElement>(".sketch-width-trigger span")).toHaveStyle({ width: "17px", height: "17px" });
  });

  it("supports a custom color and wheel-adjusted custom width", () => {
    const { container } = render(<SketchTool />);
    const colorTrigger = container.querySelector<HTMLButtonElement>(".sketch-color-trigger")!;
    const widthTrigger = container.querySelector<HTMLButtonElement>(".sketch-width-trigger")!;
    const colorIndicator = colorTrigger.querySelector("span")!;
    const initialColor = (colorIndicator as HTMLElement).style.backgroundColor;

    fireEvent.click(colorTrigger);
    fireEvent.pointerDown(container.querySelectorAll<HTMLButtonElement>(".sketch-color")[5]);
    fireEvent.click(colorTrigger);
    const colorInput = container.querySelector<HTMLInputElement>(".sketch-custom-color input")!;
    expect(colorInput.value).toBe("#ffffff");
    fireEvent.change(colorInput, { target: { value: "#123456" } });
    expect(container.querySelector(".sketch-picker-panel")).toBeNull();
    expect((colorIndicator as HTMLElement).style.backgroundColor).not.toBe(initialColor);

    fireEvent.click(widthTrigger);
    const customWidth = container.querySelector<HTMLElement>(".sketch-custom-width")!;
    expect(customWidth).toHaveAttribute("aria-valuenow", "4");
    fireEvent.wheel(customWidth, { deltaY: -100 });
    expect(customWidth).toHaveAttribute("aria-valuenow", "5");
    fireEvent.keyDown(customWidth, { key: "ArrowDown" });
    expect(customWidth).toHaveAttribute("aria-valuenow", "4");
  });

  it("uses an inline text editor instead of the browser prompt", () => {
    const prompt = vi.fn();
    window.prompt = prompt;
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    const toolButtons = container.querySelectorAll<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button");

    fireEvent.click(toolButtons[5]);
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 140, pointerId: 6 });

    const input = container.querySelector<HTMLInputElement>(".sketch-text-input");
    expect(input).toBeTruthy();
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.change(input!, { target: { value: "重点内容" } });
    fireEvent.keyDown(input!, { key: "Enter" });

    expect(container.querySelector(".sketch-text-input")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".sketch-save")).not.toBeDisabled();
  });

  it("cancels inline text entry with Escape without adding a stroke", () => {
    localStorage.removeItem("levitaire-sketch-state-v1");
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    const toolButtons = container.querySelectorAll<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button");

    fireEvent.click(toolButtons[5]);
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 140, pointerId: 7 });
    const input = container.querySelector<HTMLInputElement>(".sketch-text-input")!;
    fireEvent.change(input, { target: { value: "取消内容" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(container.querySelector(".sketch-text-input")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".sketch-save")).toBeDisabled();
  });

  it("discards the current draft without a confirmation prompt", () => {
    const confirm = vi.fn();
    window.confirm = confirm;
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 2 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 2 });
    const closeButton = container.querySelector(".sketch-close")!;
    fireEvent.click(closeButton);
    expect(confirm).not.toHaveBeenCalled();
    expect(localStorage.getItem("levitaire-sketch-state-v1")).toBeNull();
  });

  it("shows a preview before saving and exits after confirmation", async () => {
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,preview");
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 3 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 3 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 3 });
    fireEvent.click(container.querySelector(".sketch-save")!);
    expect(container.querySelector(".sketch-preview")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("save_image", expect.anything());
    const previewButtons = Array.from(container.querySelectorAll(".sketch-preview-actions button"));
    expect(previewButtons.map((button) => button.className)).toEqual(["sketch-preview-confirm", "sketch-preview-cancel"]);
    const imageWrap = container.querySelector<HTMLElement>(".sketch-preview-image-wrap")!;
    fireEvent.wheel(imageWrap, { deltaY: -100 });
    expect(container.querySelector<HTMLElement>(".sketch-preview-image")?.style.transform).toContain("scale(1.12)");
    fireEvent.click(container.querySelector(".sketch-preview-confirm")!);
    await waitFor(() => expect(container.querySelector(".sketch-preview")).toBeNull());
    expect(invoke).toHaveBeenCalledWith("save_image", expect.objectContaining({ filename: "sketch.png" }));
    toDataUrl.mockRestore();
  });

  it("closes the preview with Escape without discarding the draft", () => {
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,preview");
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 4 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 4 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 4 });
    fireEvent.click(container.querySelector(".sketch-save")!);
    expect(container.querySelector(".sketch-preview")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sketch-preview")).toBeNull();
    expect(container.querySelector(".sketch-root")).toBeTruthy();
    toDataUrl.mockRestore();
  });

  it("disables preview cancellation while saving", async () => {
    let resolveSave: ((value: boolean) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,preview");
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 5 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 5 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 5 });
    fireEvent.click(container.querySelector(".sketch-save")!);
    fireEvent.click(container.querySelector(".sketch-preview-confirm")!);
    await waitFor(() => expect(container.querySelector(".sketch-preview-cancel")).toHaveAttribute("disabled"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sketch-preview")).toBeTruthy();
    resolveSave?.(false);
    toDataUrl.mockRestore();
  });

  it("blocks closing while a background capture is in flight", async () => {
    let resolveBackground: ((value: string) => void) | undefined;
    vi.mocked(currentMonitor).mockResolvedValueOnce({ position: { x: 0, y: 0 }, size: { width: 100, height: 100 } } as never);
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<string>((resolve) => { resolveBackground = resolve; }));
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 8 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 8 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 8 });
    fireEvent.click(container.querySelector<HTMLButtonElement>(".sketch-save-with-background")!);
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>(".sketch-close")).toBeDisabled());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sketch-root")).toBeTruthy();
    resolveBackground?.("background");
  });
});
