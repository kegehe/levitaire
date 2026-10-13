/**
 * 真组件 DOM 导出 → 真 CSS 核对板（**默认跳过**，按需手动跑）。
 *
 * 为什么值得留着：`outputs/sticky-note-resize/*.png` 里那张手抄预览页可能抄漏规则（抄错看不出来），
 * 这条路径把**真组件渲染出的 DOM** + **真 CSS 文件原文**拼成一张板图，抄错无从发生；
 * 同时打印每个状态的 `offsetWidth/offsetHeight` 硬数字（宽度是否钉死 264、手动态卡片是否撑满、
 * 提示条带来多少高度差），由 `.workbuddy/design/sticky-note-resize/buildRealDom.mjs` 核对。
 *
 * 用法（默认不会随 `npm test` 跑，因为它会往 .workbuddy 写文件）：
 *   LEVITAIRE_REAL_DOM=1 npx vitest run src/tools/sticky-note/__real_dom__.test.tsx
 *   node .workbuddy/design/sticky-note-resize/buildRealDom.mjs
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import {
  clearMockListeners,
  clearMockWindowEventHandlers,
  setMockWindow,
} from "../../test/tauri-mock";
import StickyNote from "./StickyNote";

const ENABLED = Boolean(process.env.LEVITAIRE_REAL_DOM);
const mockInvoke = vi.mocked(invoke);
const OUT_DIR = ".workbuddy/design/sticky-note-resize/real-dom";
const IMG_REL = "note-1750000000000-1/img_1_0.png";

/** 一条 232×140 的占位位图（data URI）：真实便签里图片是满宽的 asset: URL，无头环境取不到 */
const PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="232" height="140"><rect width="232" height="140" fill="#3b4252"/><rect x="10" y="10" width="60" height="12" rx="3" fill="#8fbcbb"/><rect x="10" y="34" width="150" height="8" rx="2" fill="#4c566a"/><rect x="10" y="50" width="120" height="8" rx="2" fill="#4c566a"/><rect x="10" y="90" width="190" height="34" rx="4" fill="#bf616a"/></svg>`,
  );

function noteWith(overrides: { id?: string; content?: string; width?: number; height?: number }) {
  return {
    id: overrides.id ?? "note-1",
    content: overrides.content ?? "",
    colorId: "yellow",
    visible: true,
    width: overrides.width ?? 0,
    height: overrides.height ?? 0,
    createdAt: "2026-09-17T00:00:00Z",
    updatedAt: "2026-09-17T00:00:00Z",
  };
}

function mockNote(data: ReturnType<typeof noteWith>) {
  mockInvoke.mockImplementation((command: string) => {
    if (command === "get_sticky_note") return Promise.resolve(data);
    if (command === "get_sticky_note_images_dir")
      return Promise.resolve("C:/data/levitaire/sticky-images");
    return Promise.resolve();
  });
}

/** 把导出的 DOM 里的 asset: 地址换成能显示的占位图（真实窗口里那是本地图片文件） */
function inlineImages(html: string): string {
  return html.replace(/src="asset:\/\/localhost\/[^"]*"/g, `src="${PLACEHOLDER}"`);
}

function cssText(): string {
  const read = (rel: string) => readFileSync(rel, "utf8");
  // @import 在 <style> 里会去取别的文件：直接按顺序内联，先 tokens 再 global
  return (
    read("src/styles/tokens.css") +
    "\n" +
    read("src/styles/global.css").replace(/^@import.*$/gm, "") +
    "\n" +
    read("src/tools/sticky-note/StickyNote.css")
  );
}

describe.skipIf(!ENABLED)("真组件 DOM 导出（生成核对板）", () => {
  it("导出 5 个状态的 DOM 并写出核对页", async () => {
    vi.clearAllMocks();
    clearMockListeners();
    clearMockWindowEventHandlers();
    setMockWindow({ label: "sticky-note-note-1" });

    const states: Array<{ cap: string; note: string; win: string; html: string }> = [];

    // ① 自动（空）
    mockNote(noteWith({ content: "" }));
    {
      const { container, unmount } = render(<StickyNote />);
      await screen.findByLabelText("便利贴内容");
      states.push({
        cap: "① 自动（空）：宽 264、高随内容",
        note: "卡片与窗口同宽，右下角有纸角手柄。",
        win: "width: 264px",
        html: container.innerHTML,
      });
      unmount();
    }

    // ② 自动 + 图片：窗口刻意给 400 宽 = 手动尺寸刚被双击复位时的那一瞬
    clearMockListeners();
    mockNote(noteWith({ content: `[[img:${IMG_REL}]]\n说明文字写在图片下面` }));
    {
      const { container, unmount } = render(<StickyNote />);
      await screen.findByLabelText("便利贴内容");
      states.push({
        cap: "② 自动 + 图片（窗口给 400 宽）",
        note:
          "自动模式下 .sn-window 宽度钉死 264 ⇒ 卡片不会跟着窗口变宽，" +
          "此刻按内容量出的高度就是 264 宽下的真实高度。",
        win: "width: 400px",
        html: inlineImages(container.innerHTML),
      });
      unmount();
    }

    // ③ 手动尺寸 360×300：卡片撑满、正文内部滚动
    clearMockListeners();
    mockNote(
      noteWith({
        width: 360,
        height: 300,
        content: "手动尺寸：卡片撑满窗口，正文超出时内部滚动。",
      }),
    );
    {
      const { container, unmount } = render(<StickyNote />);
      await screen.findByLabelText("便利贴内容");
      await waitFor(() =>
        expect(container.querySelector(".sn-window")).toHaveAttribute("data-manual", "true"),
      );
      states.push({
        cap: "③ 手动尺寸 360×300",
        note: "data-manual → .sn-window 宽高 100%、卡片 flex 撑满、footer 与纸角贴在窗口底。",
        win: "width: 360px; height: 300px",
        html: container.innerHTML,
      });
      unmount();
    }

    // ④ 读取失败态（带重试）
    clearMockListeners();
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sticky_note") return Promise.reject("读取失败：IPC 超时");
      return Promise.resolve();
    });
    {
      const { container, unmount } = render(<StickyNote />);
      await screen.findByText(/读取便利贴失败/);
      states.push({
        cap: "④ 读取失败态（不自毁窗口）",
        note: "读不到数据时窗口按原生尺寸撑满（data-manual），给一张可重试的小卡片。",
        win: "width: 264px; height: 200px",
        html: container.innerHTML,
      });
      unmount();
    }

    // ⑤ 自动 + 提示条：粘贴一张落不下来的图片 → 接管并说明原因
    clearMockListeners();
    mockNote(noteWith({ content: "周五前把设计稿定下来" }));
    {
      const { container, unmount } = render(<StickyNote />);
      const editor = await screen.findByLabelText("便利贴内容");
      const svg = new File([new Uint8Array([0x3c, 0x73])], "icon.svg", { type: "image/svg+xml" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(svg);
      fireEvent.paste(editor, { clipboardData: dataTransfer });
      await screen.findByText(/不支持的图片格式/);
      states.push({
        cap: "⑤ 自动 + 提示条（不支持的图片格式）",
        note: "提示条插在 header 与正文之间：它会改变卡片高度，所以要重新量一次窗口高（否则 footer 与纸角被裁）。",
        win: "width: 264px",
        html: container.innerHTML,
      });
      unmount();
    }

    expect(states.length).toBe(5);
    for (const state of states) expect(state.html.length).toBeGreaterThan(200);

    mkdirSync(OUT_DIR, { recursive: true });
    const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8" /><title>便利贴 · 真组件 DOM + 真 CSS</title>
<style>
${cssText()}
  /* ── 核对板自身（不在组件范围内） */
  html, body { background: #eef1f5; overflow: visible; height: auto; }
  body { padding: 18px 20px; font: 13px/1.6 system-ui, "Microsoft YaHei", sans-serif; color: #20232e; }
  h1 { font-size: 17px; margin-bottom: 4px; }
  .sub { color: #5b6472; font-size: 12px; margin-bottom: 16px; }
  .row { display: flex; gap: 26px; align-items: flex-start; flex-wrap: wrap; }
  .cell { width: 430px; }
  .cap { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  .cap code { color: #c43b30; }
  .win { position: relative; background: #dfe4ea; outline: 1px dashed rgb(60 70 90 / 0.35); outline-offset: -1px; border-radius: 8px; }
  .win > .sn-window { outline: none; }
  .note { margin-top: 8px; color: #5b6472; font-size: 11.5px; }
</style></head>
<body>
  <h1>便利贴 · 真组件 DOM + 真 CSS 核对板</h1>
  <div class="sub">DOM 来自 <code>StickyNote.tsx</code> 的真实渲染输出，样式来自 <code>global.css</code> / <code>tokens.css</code> / <code>StickyNote.css</code> 的原文；灰底虚线框是「原生窗口」的边界（真实窗口透明）。</div>
  <div class="row">
${states
  .map(
    (s) => `    <div class="cell">
      <div class="cap">${s.cap} <code>${s.win}</code></div>
      <div class="win" style="${s.win}">${s.html}</div>
      <div class="note">${s.note}</div>
    </div>`,
  )
  .join("\n")}
  </div>
  <script>
    // 量尺寸用 offsetWidth/offsetHeight（入场动画的 scale(.99) 会让 getBoundingClientRect 偏小）。
    // ⚠️ 不能用 requestAnimationFrame：无头 Chrome + --virtual-time-budget 下 rAF 不保证被服务
    // （实测 load 里挂 rAF 后 dump-dom 拿不到任何回报），改成 load + 定时器双保险。
    function measure() {
      try {
        const rows = [...document.querySelectorAll(".win")].map((win) => {
          const note = win.querySelector(".sn-window");
          const card = win.querySelector(".sn-card");
          return {
            win: (win.style.width || "-") + (win.style.height ? " / " + win.style.height : ""),
            noteW: note.offsetWidth,
            noteH: note.offsetHeight,
            cardW: card.offsetWidth,
            cardH: card.offsetHeight,
            manual: note.dataset.manual === "true",
          };
        });
        document.getElementById("measure").textContent = JSON.stringify(rows);
        document.documentElement.dataset.height = String(
          Math.ceil(document.body.getBoundingClientRect().height),
        );
      } catch (error) {
        // 量失败也要留痕：否则出图脚本只会看到「没有回报」，排不出原因
        document.documentElement.dataset.measureError = String(error);
      }
    }
    window.addEventListener("load", () => setTimeout(measure, 0));
    setTimeout(measure, 300);
  </script>
  <pre id="measure" hidden></pre>
</body></html>`;
    writeFileSync(join(OUT_DIR, "index.html"), page);
    console.log("REAL_DOM_WRITTEN", join(OUT_DIR, "index.html"));
  });
});
