/**
 * 时间工具「沙漏」显示样式的**真机渲染核对**页（临时工具，不参与产品构建）。
 *
 * 为什么要它：沙漏是纯 SVG + CSS，设计稿是手写 mock，CSS 一改 mock 就失真 ——
 * 只有把**真实 Hourglass 组件**放进真实浏览器渲染，量出的尺寸与看到的形状才可信。
 * Hourglass 不碰 Tauri API，所以这里不需要打桩 IPC。
 *
 * 用法（`npx vite --port 5199` 后打开 http://localhost:5199/timer-preview.html）：
 *   ?theme=dark|light   明暗主题（默认 dark）
 *   ?zoom=N             整页缩放（图形仍是真实 112px 布局，只是放大看细节）
 *   ?step=0.1           进度标尺的步长
 *   ?at=0.5             只画一个进度、单独一大格（看颈口 / 流沙 / 尖堆）
 *   ?bars=1             只画进度标尺，不画暂停态
 *   ?live=1             额外挂一个真实走动的倒计时（看动画连续性）
 *   ?compare=1          改造前 vs 改造后两排对照（?compare=2 只看改造后的细节）
 *   ?probe=1            在页面尾部打印流沙动画的实测值（便于 grep）
 */
import { createRoot } from "react-dom/client";
// ⚠️ 必须把仓库的全局样式一起加载：global.css 里有 reset + tokens.css。
// 漏了它，量出来的宽高是错的（子元素按 content-box 算）。
import "../../../styles/global.css";
// ⚠️ `.hg-*` 那条规则的宿主是 TimerTool.css（由 TimerTool.tsx 导入），**不是** Hourglass.tsx！
// 这里只 import Hourglass 的话，沙漏所有形状都会退回默认 `fill: black`
// （clipPath 仍生效，于是看起来"像"沙漏，但轮廓/端板/流沙全丢、沙子变纯黑），极易误判。
import "../TimerTool.css";
import "./timer-preview.css";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Hourglass from "../Hourglass";
import LegacyHourglass from "./LegacyHourglass";
import { applyThemePreferences } from "../../../styles/themePreferences";
import type { ThemePreferences } from "../../../styles/themePreferences";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const probe = params.get("probe") === "1";
const barsOnly = params.get("bars") === "1";
const live = params.get("live") === "1";
const step = Number(params.get("step") ?? "0.1");
const zoom = Number(params.get("zoom") ?? "1");
/** ?at=0.5 —— 只画一个进度、单独一大格，用来看局部（颈口/流沙/尖堆） */
const at = params.get("at");

const prefs: ThemePreferences = {
  theme: theme as ThemePreferences["theme"],
  accent: "blue",
  scheme: "cloud",
};
localStorage.setItem("levitaire-theme", theme);
localStorage.setItem("levitaire-theme-accent", "blue");
localStorage.setItem("levitaire-theme-scheme", "cloud");
applyThemePreferences(prefs);

const STEPS: number[] = [];
for (let p = 1; p > -0.001; p -= step) STEPS.push(Number(p.toFixed(4)));

function Cell({ progress, running }: { progress: number; running: boolean }) {
  return (
    <div className="cell">
      <div className={`timer-countdown-view${running ? " is-running" : ""}`}>
        <Hourglass progress={progress} running={running} />
        <strong className="timer-primary-value timer-hg-value">{progress.toFixed(2)}</strong>
      </div>
    </div>
  );
}

function CompareRow({ title, legacy = false, scale = 1, only }: { title: string; legacy?: boolean; scale?: number; only?: string[] }) {
  const ps = only ?? ["1.00", "0.75", "0.50", "0.25", "0.00"];
  return (
    <>
      <h2>{title}</h2>
      <div className="row">
        {ps.map((text) => (
          <div className="cell" key={text} style={{ zoom: scale } as CSSProperties}>
            <div className={`timer-countdown-view${legacy ? "" : " is-running"}`}>
              {legacy ? <LegacyHourglass progress={Number(text)} running /> : <Hourglass progress={Number(text)} running />}
              <strong className="timer-primary-value timer-hg-value">{text}</strong>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function LiveCountdown() {
  const total = 30;
  const [left, setLeft] = useState(total);
  useEffect(() => {
    const id = window.setInterval(() => setLeft((v) => (v <= 0.1 ? total : Number((v - 0.5).toFixed(2)))), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="cell cell-live">
      <div className="timer-countdown-view is-running">
        <Hourglass progress={left / total} running />
        <strong key={Math.ceil(left)} className="timer-primary-value timer-hg-value">
          {Math.ceil(left)}
        </strong>
      </div>
    </div>
  );
}

function App() {
  if (at !== null) {
    return (
      <div className="page" style={{ zoom } as CSSProperties}>
        <div className="row">
          <Cell progress={Number(at)} running />
        </div>
        {probe && <Probe />}
      </div>
    );
  }
  if (params.get("compare") === "1") {
    return (
      <div className="page" style={{ zoom } as CSSProperties}>
        <CompareRow title="改造前 · 直锥瓶身（领结） / 堆沙顶面一刀平 / 流沙是无纹理细杆" legacy scale={2} />
        <CompareRow title="改造后 · 弧线瓶身 / 沙面凹坑 / 休止角尖堆 / 流沙上粗下细带落沙纹" scale={2} />
      </div>
    );
  }
  if (params.get("compare") === "2") {
    return (
      <div className="page" style={{ zoom } as CSSProperties}>
        <CompareRow title="改造后 · 细节（沙面凹坑 / 流沙落沙纹 / 堆沙尖堆）" scale={5} only={["0.75", "0.50"]} />
      </div>
    );
  }
  return (
    <div className="page" style={{ zoom } as CSSProperties}>
      <h1>沙漏 · 真机渲染核对（{theme}）</h1>
      {!barsOnly && (
        <>
          <h2>进度标尺（running）</h2>
          <div className="row">
            {STEPS.map((p) => (
              <Cell key={p} progress={p} running />
            ))}
          </div>
          <h2>暂停态（对比凹坑收平 / 流沙断开）</h2>
          <div className="row">
            {[1, 0.66, 0.33, 0.05].map((p) => (
              <Cell key={p} progress={p} running={false} />
            ))}
          </div>
        </>
      )}
      {live && (
        <>
          <h2>实时走动</h2>
          <div className="row">
            <LiveCountdown />
          </div>
        </>
      )}
      {probe && <Probe />}
    </div>
  );
}

function Probe() {
  useEffect(() => {
    const log: string[] = [];
    const read = (label: string) => {
      const flow = document.querySelector<SVGLineElement>(".hg-stream-flow");
      const svg = document.querySelector<SVGSVGElement>(".timer-hourglass");
      const box = svg?.getBoundingClientRect();
      log.push(
        `${label} flow=${flow ? getComputedStyle(flow).strokeDashoffset + "/" + getComputedStyle(flow).animationName : "none"}` +
          ` svg=${box ? box.width.toFixed(1) + "x" + box.height.toFixed(1) : "none"}`,
      );
    };
    const timers: number[] = [];
    timers.push(window.setTimeout(() => read("t1"), 400));
    timers.push(
      window.setTimeout(() => {
        read("t2");
        const out = document.createElement("pre");
        out.className = "probe";
        out.textContent = log.join("\n") + `\nprobe-cells=${document.querySelectorAll(".cell").length}`;
        document.body.appendChild(out);
      }, 1100),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(<App />);
