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
