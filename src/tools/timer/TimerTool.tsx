import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import { applyThemePreferences, getStoredThemePreferences, subscribeThemePreferences } from "../../styles/themePreferences";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import "./TimerTool.css";

type View = "clock" | "countdown";
type Display = "compact" | "ring";
interface TimerItem { id: string; kind: "countdown" | "stopwatch"; durationSecs: number; remainingSecs: number; running: boolean; completed: boolean; }
interface TimersPayload { timers: TimerItem[]; }

const LUNAR_DAY_NAMES = [
  "", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];

function formatLunarDate(date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "long", day: "numeric" }).formatToParts(date);
    const month = parts.find((part) => part.type === "month")?.value ?? "";
    const day = Number(parts.find((part) => part.type === "day")?.value);
    return month && day >= 1 && day <= 30 ? `农历${month}${LUNAR_DAY_NAMES[day]}` : "";
  } catch {
    return "";
  }
}

function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function TimerTool() {
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [view, setView] = useState<View>("clock");
  const [display, setDisplay] = useState<Display>(() => localStorage.getItem("levitaire-timer-display") === "ring" ? "ring" : "compact");
  const [now, setNow] = useState(() => new Date());
  const [timer, setTimer] = useState<TimerItem | null>(null);
  const [customMinutes, setCustomMinutes] = useState("5");
  const [lunarEnabled, setLunarEnabled] = useState(true);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.classList.add("timer-window");
    void emit("timer-window-ready");
    const ready = listen("timer-window-ready-request", () => void emit("timer-window-ready"));
    return () => {
      document.body.classList.remove("timer-window");
      void ready.then((stop) => stop());
    };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    subscribeThemePreferences().then((stop) => { unlisten = stop; }).catch(() => {});
    return () => unlisten?.();
  }, []);
  useEffect(() => persistWindowPositionOnMove("time-overlay"), []);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    const applyPayload = (payload: TimersPayload) => setTimer(payload.timers.find((item) => item.kind === "countdown") ?? null);
    let cancelled = false;
    invoke<TimersPayload>("get_timers").then((payload) => { if (!cancelled) applyPayload(payload); }).catch(() => {});
    const unlisten = listen<TimersPayload>("timers-changed", (event) => applyPayload(event.payload));
    return () => { cancelled = true; void unlisten.then((stop) => stop()); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("get_timer_lunar_enabled").then((enabled) => {
      if (!cancelled) setLunarEnabled(enabled);
    }).catch(() => {});
    const unlisten = listen<boolean>("timer-lunar-enabled-changed", (event) => setLunarEnabled(event.payload));
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    let lastHeight = 0;
    const resizeToContent = () => {
      const height = Math.ceil(shell.getBoundingClientRect().height);
      if (!height || height === lastHeight) return;
      lastHeight = height;
      win.setSize(new LogicalSize(300, height)).catch(() => {});
    };

    resizeToContent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [win]);
  useEffect(() => { localStorage.setItem("levitaire-timer-display", display); }, [display]);

  const value = timer?.remainingSecs ?? 0;
  const lunarDate = useMemo(() => formatLunarDate(now), [now]);
  const weekday = useMemo(() => new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now), [now]);
  const progress = timer && timer.durationSecs > 0 ? Math.min(1, Math.max(0, timer.remainingSecs / timer.durationSecs)) : 0;
  const mutate = async (command: string, args: Record<string, unknown> = {}) => {
    if (!timer) return;
    await invoke(command, { id: timer.id, ...args }).catch(() => {});
  };

  return <div ref={shellRef} className={`timer-shell timer-${display}`}>
    <header className="timer-header" onMouseDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button,input")) void win.startDragging(); }}>
      <div className="timer-tabs" role="tablist" aria-label="时钟工具模式">
        <button className={view === "clock" ? "is-active" : ""} onClick={() => setView("clock")}>时钟</button>
        <button className={view === "countdown" ? "is-active" : ""} onClick={() => setView("countdown")}>倒计时</button>
      </div>
      <div className="timer-actions">
        {view === "countdown" && <button aria-label="切换倒计时样式" data-tooltip="切换样式" onClick={() => setDisplay(display === "compact" ? "ring" : "compact")}><Icon name="Palette" size={14} /></button>}
        <button aria-label="关闭时钟工具" data-tooltip="关闭" onClick={() => void invoke("hide_timer_window")}><Icon name="X" size={14} /></button>
      </div>
    </header>
    {view === "clock" ? <main className="timer-clock-view">
      <strong className="timer-local-clock-value">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</strong>
      <span className="timer-date">{now.toLocaleDateString()} · {weekday}{lunarEnabled && lunarDate ? ` · ${lunarDate}` : ""}</span>
      <button className="timer-secondary-action" onClick={() => setView("countdown")}><Icon name="Timer" size={14} />设置倒计时</button>
    </main> : <main className={`timer-countdown-view${timer?.completed ? " is-complete" : ""}`}>
      <span className="timer-eyebrow">倒计时</span>
      {display === "ring" ? <div className="timer-ring-view"><svg viewBox="0 0 120 120" aria-hidden><circle className="timer-ring-bg" cx="60" cy="60" r="50" /><circle className="timer-ring-fg" cx="60" cy="60" r="50" style={{ strokeDashoffset: 314 * (1 - progress) }} /></svg><strong>{formatTime(value)}</strong></div> : <strong className="timer-primary-value">{formatTime(value)}</strong>}
      {timer && !timer.running && <div className="timer-presets">{[1, 5, 10, 25].map((minutes) => <button key={minutes} onClick={() => void mutate("set_timer_duration", { seconds: minutes * 60 })}>{minutes}分</button>)}<input aria-label="自定义分钟数" inputMode="numeric" value={customMinutes} onChange={(event) => setCustomMinutes(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))} /><button disabled={!customMinutes} onClick={() => void mutate("set_timer_duration", { seconds: Math.min(1440, Math.max(1, Number(customMinutes))) * 60 })}>设定</button></div>}
      <div className="timer-controls"><button className="timer-play" onClick={() => void mutate(timer?.running ? "pause_timer" : "start_timer")}><Icon name={timer?.running ? "Pause" : "Play"} size={16} />{timer?.running ? "暂停" : "开始"}</button><button aria-label="增加一分钟" data-tooltip="增加一分钟" onClick={() => void mutate("add_timer_seconds", { seconds: 60 })}><Icon name="Plus" size={16} /></button><button aria-label="重置倒计时" data-tooltip="重置" onClick={() => void mutate("reset_timer")}><Icon name="RotateCcw" size={15} /></button></div>
    </main>}
  </div>;
}

export default TimerTool;
