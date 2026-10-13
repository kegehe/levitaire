import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AnnotationToolbar from "./AnnotationToolbar";
import { useAnnotations } from "./useAnnotations";
import {
  DEFAULT_COLOR,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_TOOL,
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
} from "./types";
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
      strokeWidth={DEFAULT_STROKE_WIDTH}
      onStrokeWidthChange={vi.fn()}
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

// 颜色/粗细现在是「工具的二级面板」，只在选中绘图工具后才出现，故用矩形工具渲染。
function StyleHarness() {
  const [color, setColor] = useState(DEFAULT_COLOR);
  const annotations = useAnnotations();

  return (
    <AnnotationToolbar
      tool="rect"
      setTool={vi.fn()}
      color={color}
      setColor={setColor}
      strokeWidth={DEFAULT_STROKE_WIDTH}
      onStrokeWidthChange={vi.fn()}
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
    render(<StyleHarness />);

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
          tool="rect"
          setTool={vi.fn()}
          color={DEFAULT_COLOR}
          setColor={vi.fn()}
          strokeWidth={DEFAULT_STROKE_WIDTH}
          onStrokeWidthChange={vi.fn()}
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
          strokeWidth={DEFAULT_STROKE_WIDTH}
          onStrokeWidthChange={vi.fn()}
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
        strokeWidth={DEFAULT_STROKE_WIDTH}
        onStrokeWidthChange={vi.fn()}
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

// 线宽圆点：悬停其上滚轮 / 方向键调节（对齐 Snipaste 与草稿工具的宽度控件）
function WidthHarness({ busy = null }: { busy?: string | null }) {
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_STROKE_WIDTH);
  const annotations = useAnnotations();

  return (
    <AnnotationToolbar
      tool="rect"
      setTool={vi.fn()}
      color={DEFAULT_COLOR}
      setColor={vi.fn()}
      strokeWidth={strokeWidth}
      onStrokeWidthChange={setStrokeWidth}
      annotations={annotations}
      busy={busy}
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

describe("AnnotationToolbar 线宽圆点", () => {
  const dot = () => document.querySelector(".ss-width-dot") as HTMLElement;

  it("role/aria 齐全，初始值 = 默认线宽", () => {
    render(<WidthHarness />);
    expect(dot()).not.toBeNull();
    expect(dot().getAttribute("role")).toBe("spinbutton");
    expect(dot().getAttribute("aria-valuemin")).toBe(String(MIN_STROKE_WIDTH));
    expect(dot().getAttribute("aria-valuemax")).toBe(String(MAX_STROKE_WIDTH));
    expect(dot().getAttribute("aria-valuenow")).toBe(String(DEFAULT_STROKE_WIDTH));
  });

  it("滚轮：上滚 +1、下滚 -1", () => {
    render(<WidthHarness />);
    act(() => {
      fireEvent.wheel(dot(), { deltaY: -100 });
    });
    expect(dot().getAttribute("aria-valuenow")).toBe("6");
    act(() => {
      fireEvent.wheel(dot(), { deltaY: 100 });
    });
    expect(dot().getAttribute("aria-valuenow")).toBe("5");
  });

  it("滚轮在边界处被钳制在 [1, 32]", () => {
    render(<WidthHarness />);
    for (let i = 0; i < 40; i++) {
      act(() => {
        fireEvent.wheel(dot(), { deltaY: 100 });
      });
    }
    expect(dot().getAttribute("aria-valuenow")).toBe(String(MIN_STROKE_WIDTH));
    for (let i = 0; i < 60; i++) {
      act(() => {
        fireEvent.wheel(dot(), { deltaY: -100 });
      });
    }
    expect(dot().getAttribute("aria-valuenow")).toBe(String(MAX_STROKE_WIDTH));
  });

  it("方向键也能调节（↑/→ 加，↓/← 减）", () => {
    render(<WidthHarness />);
    act(() => {
      fireEvent.keyDown(dot(), { key: "ArrowUp" });
    });
    expect(dot().getAttribute("aria-valuenow")).toBe("6");
    act(() => {
      fireEvent.keyDown(dot(), { key: "ArrowLeft" });
    });
    expect(dot().getAttribute("aria-valuenow")).toBe("5");
    act(() => {
      fireEvent.keyDown(dot(), { key: "ArrowDown" });
    });
    expect(dot().getAttribute("aria-valuenow")).toBe("4");
  });

  it("触控板横向滑动（deltaY=0）不改线宽", () => {
    render(<WidthHarness />);
    act(() => {
      fireEvent.wheel(dot(), { deltaY: 0, deltaX: 120 });
    });
    expect(dot().getAttribute("aria-valuenow")).toBe(String(DEFAULT_STROKE_WIDTH));
  });

  it("busy 时不响应滚轮与方向键", () => {
    render(<WidthHarness busy="save" />);
    act(() => {
      fireEvent.wheel(dot(), { deltaY: -100 });
      fireEvent.keyDown(dot(), { key: "ArrowUp" });
    });
    expect(dot().getAttribute("aria-valuenow")).toBe(String(DEFAULT_STROKE_WIDTH));
    expect(dot().getAttribute("aria-disabled")).toBe("true");
  });
});
