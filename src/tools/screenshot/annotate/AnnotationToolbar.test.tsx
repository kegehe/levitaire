import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AnnotationToolbar from "./AnnotationToolbar";
import { useAnnotations } from "./useAnnotations";
import { DEFAULT_COLOR, DEFAULT_TOOL, DEFAULT_WIDTH_INDEX } from "./types";
import { useState } from "react";

function ToolbarHarness() {
  const [color, setColor] = useState(DEFAULT_COLOR);
  const annotations = useAnnotations();

  return (
    <AnnotationToolbar
      tool={DEFAULT_TOOL}
      setTool={vi.fn()}
      color={color}
      setColor={setColor}
      widthIndex={DEFAULT_WIDTH_INDEX}
      setWidthIndex={vi.fn()}
      annotations={annotations}
      busy={null}
      error={null}
      ready
      onCopy={vi.fn()}
      onSave={vi.fn()}
      onOcr={vi.fn()}
      onPin={vi.fn()}
      onCancel={vi.fn()}
    />
  );
}

describe("AnnotationToolbar color picker", () => {
  it("supports selecting a custom color while keeping the selected value", () => {
    render(<ToolbarHarness />);

    const picker = document.querySelector("input.ss-color-custom-input") as HTMLInputElement;
    expect(picker).not.toBeNull();
    expect(picker.type).toBe("color");
    expect(picker.value).toBe(DEFAULT_COLOR.toLowerCase());

    act(() => {
      fireEvent.change(picker, { target: { value: "#123456" } });
    });

    expect(picker.value).toBe("#123456");
    const swatch = document.querySelector(".ss-color-custom-swatch");
    expect(swatch).toHaveClass("active");
    expect(swatch?.getAttribute("style")).toContain("#123456");
  });

  it("disables the custom picker while an export is in progress", () => {
    function BusyHarness() {
      const annotations = useAnnotations();
      return (
        <AnnotationToolbar
          tool={DEFAULT_TOOL}
          setTool={vi.fn()}
          color={DEFAULT_COLOR}
          setColor={vi.fn()}
          widthIndex={DEFAULT_WIDTH_INDEX}
          setWidthIndex={vi.fn()}
          annotations={annotations}
          busy="save"
          error={null}
          ready
          onCopy={vi.fn()}
          onSave={vi.fn()}
          onOcr={vi.fn()}
          onPin={vi.fn()}
          onCancel={vi.fn()}
        />
      );
    }

    render(<BusyHarness />);
    expect(document.querySelector("input.ss-color-custom-input")).toBeDisabled();
  });
});

describe("AnnotationToolbar tool group", () => {
  it("移动工具排在第一位，且默认选中", () => {
    render(<ToolbarHarness />);
    const tools = Array.from(document.querySelectorAll(".ss-annotate-toolbar .ss-tool"));
    expect(tools[0].getAttribute("aria-label")).toBe("移动");
    expect(tools[0].className).toContain("ss-tool-active");
    // 默认不再是矩形工具
    expect(document.querySelector('[aria-label="矩形"]')?.className).not.toContain(
      "ss-tool-active",
    );
  });

  it("点击工具按钮回传对应的 kind", () => {
    const setTool = vi.fn();
    function Harness() {
      const annotations = useAnnotations();
      return (
        <AnnotationToolbar
          tool="move"
          setTool={setTool}
          color={DEFAULT_COLOR}
          setColor={vi.fn()}
          widthIndex={DEFAULT_WIDTH_INDEX}
          setWidthIndex={vi.fn()}
          annotations={annotations}
          busy={null}
          error={null}
          ready
          onCopy={vi.fn()}
          onSave={vi.fn()}
          onOcr={vi.fn()}
          onPin={vi.fn()}
          onCancel={vi.fn()}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(document.querySelector('[aria-label="马赛克"]') as HTMLElement);
    expect(setTool).toHaveBeenCalledWith("mosaic");
  });
});

describe("AnnotationToolbar tooltip placement", () => {
  function PlacementHarness({ above }: { above?: boolean }) {
    const annotations = useAnnotations();
    return (
      <AnnotationToolbar
        tool={DEFAULT_TOOL}
        setTool={vi.fn()}
        color={DEFAULT_COLOR}
        setColor={vi.fn()}
        widthIndex={DEFAULT_WIDTH_INDEX}
        setWidthIndex={vi.fn()}
        annotations={annotations}
        busy={null}
        error={null}
        ready
        above={above}
        onCopy={vi.fn()}
        onSave={vi.fn()}
        onOcr={vi.fn()}
        onPin={vi.fn()}
        onCancel={vi.fn()}
      />
    );
  }

  // 这个类名是 tooltip 方向翻转的唯一开关（见 ScreenshotTool.css 的 .ss-toolbar-above）：
  // 工具栏翻到选区上方时，向上弹的浮层会越过窗口上边界被裁掉。
  it("翻到选区上方时给包裹层打上 ss-toolbar-above", () => {
    render(<PlacementHarness above />);
    expect(document.querySelector(".ss-toolbar-wrap")).toHaveClass("ss-toolbar-above");
  });

  it("默认（工具栏在选区下方）不带该修饰类，浮层仍向上弹", () => {
    render(<PlacementHarness above={false} />);
    expect(document.querySelector(".ss-toolbar-wrap")).not.toHaveClass("ss-toolbar-above");
  });
});
