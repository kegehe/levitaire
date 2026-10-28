import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockListeners, emitMockEvent, mockHide, setMockWindow } from "../../test/tauri-mock";
import PinOcrResult from "./PinOcrResult";

const mockInvoke = vi.mocked(invoke);

const OCR_TEXT = "Hello world";

function showOcr(text = OCR_TEXT) {
  act(() => emitMockEvent("pin-ocr-show", { pinId: 1, text }));
}

beforeEach(() => {
  setMockWindow({ label: "pin-ocr" });
  clearMockListeners();
  mockHide.mockClear();
  mockInvoke.mockReset();
  // hide() 返回 undefined 会让组件里的 .catch 直接炸
  mockHide.mockResolvedValue(undefined);
  mockInvoke.mockImplementation((command: string) => {
    if (command === "get_ai_config") return Promise.resolve({ api_key: "test-key" });
    return Promise.resolve();
  });
});

afterEach(() => {
  clearMockListeners();
});

describe("OCR 结果窗", () => {
  it("关闭窗口时取消进行中的翻译，不再继续消耗额度", async () => {
    render(<PinOcrResult />);
    showOcr();

    fireEvent.click(await screen.findByRole("button", { name: "翻译" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "call_ai_stream",
        expect.objectContaining({ prompt: OCR_TEXT }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(mockHide).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("cancel_ai_stream", expect.anything());
  });

  it("配置查询未返回就关窗：这次翻译直接作废，不发起请求", async () => {
    let resolveConfig: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_ai_config") {
        return new Promise((resolve) => {
          resolveConfig = resolve;
        });
      }
      return Promise.resolve();
    });

    render(<PinOcrResult />);
    showOcr();

    fireEvent.click(await screen.findByRole("button", { name: "翻译" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    // 配置查询在关窗之后才返回：此时不应再发起 AI 请求
    await act(async () => {
      resolveConfig({ api_key: "test-key" });
      await Promise.resolve();
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("call_ai_stream", expect.anything());
    expect(screen.queryByPlaceholderText("翻译中...")).toBeNull();
  });
});
