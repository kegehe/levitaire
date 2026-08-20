/** OCR 引擎标识 → 展示名称（对应后端 ocr::EngineId::as_str） */
export const OCR_ENGINE_LABELS: Readonly<Record<string, string>> = {
  windows: "Windows 内置 OCR",
  paddle: "PaddleOCR（本地 ONNX）",
};
