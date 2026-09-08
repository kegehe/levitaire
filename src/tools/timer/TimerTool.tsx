import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import { applyThemePreferences, getStoredThemePreferences, subscribeThemePreferences } from "../../styles/themePreferences";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import { buildDayNotes, getDayNote } from "./festivals";
import "./TimerTool.css";

type View = "clock" | "countdown" | "stopwatch" | "calendar";
type Display = "compact" | "ring";
type ClockFace = "digital" | "analog";
interface TimerItem {
  id: string;
  label: string;
  kind: "countdown" | "stopwatch";
  durationSecs: number;
  remainingSecs: number;
  elapsedSecs: number;
  running: boolean;
  completed: boolean;
  startedUnixMs: number | null;
  laps: number[];
}
interface TimersPayload { timers: TimerItem[]; }
interface CalendarCell { date: Date; isCurrentMonth: boolean; }

const LUNAR_DAY_NAMES = [
  "", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];

const RING_RADIUS = 50;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const CLOCK_FACE_KEY = "levitaire-timer-clock-style";
const CLOCK_FACE_CENTER = 60;
/** 鼠标移出工具区域后，延迟收起顶部工具条的时间（避免划过边缘时闪烁） */
const CHROME_COLLAPSE_DELAY_MS = 200;

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

function formatLunarDay(date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "long", day: "numeric" }).formatToParts(date);
    const month = parts.find((part) => part.type === "month")?.value ?? "";
    const day = Number(parts.find((part) => part.type === "day")?.value);
    if (!month || day < 1 || day > 30) return "";
    return day === 1 ? month : LUNAR_DAY_NAMES[day];
  } catch {
    return "";
  }
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function buildCalendarCells(month: Date): CalendarCell[] {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const previousMonthDays = new Date(year, monthIndex, 0).getDate();
  const cells: CalendarCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const dayOffset = index - firstDay.getDay();
    if (dayOffset < 0) {
      cells.push({ date: new Date(year, monthIndex - 1, previousMonthDays + dayOffset + 1), isCurrentMonth: false });
    } else if (dayOffset >= daysInMonth) {
      cells.push({ date: new Date(year, monthIndex + 1, dayOffset - daysInMonth + 1), isCurrentMonth: false });
    } else {
      cells.push({ date: new Date(year, monthIndex, dayOffset + 1), isCurrentMonth: true });
    }
  }
  return cells;
}

function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/** 表盘刻度/数字的极坐标换算：0° 指向 12 点方向，角度顺时针递增。 */
function facePoint(radius: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: CLOCK_FACE_CENTER + radius * Math.sin(rad), y: CLOCK_FACE_CENTER - radius * Math.cos(rad) };
}

/** 模拟指针表盘：60 刻度 + 1-12 数字 + 时/分/秒三针。
 * 指针端点由时分秒直接折算为极坐标，免去旋转插值的绕圈跳变问题，
 * 时钟页签每秒驱动 now 刷新，秒针跳秒、分/时针按比例平滑推进。 */
function AnalogFace({ now }: { now: Date }) {
  const seconds = now.getSeconds();
  const minuteTotal = now.getMinutes() + seconds / 60;
  const hourTotal = now.getHours() % 12 + minuteTotal / 60;
  const timeText = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const ticks = Array.from({ length: 60 }, (_, index) => {
    const major = index % 5 === 0;
    const inner = facePoint(major ? 49 : 51.5, index * 6);
    const outer = facePoint(54, index * 6);
    return (
      <line
        key={index}
        className={major ? "timer-face-tick-major" : "timer-face-tick-minor"}
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
      />
    );
  });
  const numbers = Array.from({ length: 12 }, (_, index) => {
    const point = facePoint(40, (index + 1) * 30);
    return (
      <text key={index + 1} className="timer-face-number" x={point.x} y={point.y} textAnchor="middle" dominantBaseline="central">
        {index + 1}
      </text>
    );
  });
  const hourPoint = facePoint(23, hourTotal * 30);
  const minutePoint = facePoint(33, minuteTotal * 6);
  const secondPoint = facePoint(45, seconds * 6);
  const secondTail = facePoint(-7, seconds * 6);
  return (
    <svg className="timer-clock-face" viewBox="0 0 120 120" role="img" aria-label={`表盘时钟，${timeText}`}>
      <circle className="timer-face-dial" cx={CLOCK_FACE_CENTER} cy={CLOCK_FACE_CENTER} r={54} />
      {ticks}
      {numbers}
      <line className="timer-face-hand-hour" x1={CLOCK_FACE_CENTER} y1={CLOCK_FACE_CENTER} x2={hourPoint.x} y2={hourPoint.y} strokeLinecap="round" />
      <line className="timer-face-hand-minute" x1={CLOCK_FACE_CENTER} y1={CLOCK_FACE_CENTER} x2={minutePoint.x} y2={minutePoint.y} strokeLinecap="round" />
      <line className="timer-face-hand-second" x1={secondTail.x} y1={secondTail.y} x2={secondPoint.x} y2={secondPoint.y} strokeLinecap="round" />
      <circle className="timer-face-cap" cx={CLOCK_FACE_CENTER} cy={CLOCK_FACE_CENTER} r={3.5} />
      <circle className="timer-face-cap-accent" cx={CLOCK_FACE_CENTER} cy={CLOCK_FACE_CENTER} r={1.5} />
    </svg>
  );
}

function TimerTool() {
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [view, setView] = useState<View>("clock");
  const [chromeOpen, setChromeOpen] = useState(false);
  const [display, setDisplay] = useState<Display>(() => localStorage.getItem("levitaire-timer-display") === "ring" ? "ring" : "compact");
  const [clockFace, setClockFace] = useState<ClockFace>(() => localStorage.getItem(CLOCK_FACE_KEY) === "analog" ? "analog" : "digital");
  const [now, setNow] = useState(() => new Date());
  const [timer, setTimer] = useState<TimerItem | null>(null);
  const [stopwatch, setStopwatch] = useState<TimerItem | null>(null);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [customMinutes, setCustomMinutes] = useState("5");
  const [lunarEnabled, setLunarEnabled] = useState(true);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date()));
  const followsTodayRef = useRef(true);
  const lastCalendarDayRef = useRef(dateKey(new Date()));
  const creatingStopwatchRef = useRef(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const chromeCloseTimer = useRef<number | null>(null);

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
  useEffect(() => () => {
    if (chromeCloseTimer.current) window.clearTimeout(chromeCloseTimer.current);
  }, []);
  useEffect(() => {
    // 倒计时/秒表数值由后端事件驱动，无需每秒刷新；日历“今天”高亮仅在跨天时变化。
    // 因此仅时钟页签每秒走时，日历页签改为跨天瞬间更新一次。
    if (view === "clock") {
      setNow(new Date());
      const interval = window.setInterval(() => setNow(new Date()), 1000);
      return () => window.clearInterval(interval);
    }
    if (view !== "calendar") return;
    setNow(new Date());
    let lastDay = dateKey(new Date());
    let timeout = 0;
    const refreshIfDayChanged = () => {
      const todayKey = dateKey(new Date());
      if (todayKey === lastDay) return;
      lastDay = todayKey;
      setNow(new Date());
    };
    const scheduleNextMidnight = () => {
      const current = new Date();
      const nextMidnight = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, 0, 0, 0, 0);
      timeout = window.setTimeout(() => {
        refreshIfDayChanged();
        scheduleNextMidnight();
      }, nextMidnight.getTime() - current.getTime());
    };
    scheduleNextMidnight();
    // 兜底：手动改系统时间/时区变化会使上面的午夜定时器失准，每分钟轻量校准一次（仅在跨天时才刷新）。
    const fallback = window.setInterval(refreshIfDayChanged, 60_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(fallback);
    };
  }, [view]);
  useEffect(() => {
    const todayKey = dateKey(now);
    if (todayKey === lastCalendarDayRef.current) return;
    lastCalendarDayRef.current = todayKey;
    if (!followsTodayRef.current) return;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    setVisibleMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedDate(todayKey);
  }, [now]);
  useEffect(() => {
    const applyPayload = (payload: TimersPayload) => {
      setTimer(payload.timers.find((item) => item.kind === "countdown") ?? null);
      setStopwatch(payload.timers.find((item) => item.kind === "stopwatch") ?? null);
    };
    let changedSinceMount = false;
    let cancelled = false;
    invoke<TimersPayload>("get_timers").then((payload) => { if (!cancelled && !changedSinceMount) applyPayload(payload); }).catch(() => {});
    const unlisten = listen<TimersPayload>("timers-changed", (event) => { changedSinceMount = true; applyPayload(event.payload); });
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
      win.setSize(new LogicalSize(view === "calendar" ? 380 : 300, height)).catch(() => {});
    };

    resizeToContent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [view, win]);
  useEffect(() => { localStorage.setItem("levitaire-timer-display", display); }, [display]);
  useEffect(() => { localStorage.setItem(CLOCK_FACE_KEY, clockFace); }, [clockFace]);

  const value = timer?.remainingSecs ?? 0;
  const lunarDate = useMemo(() => formatLunarDate(now), [now]);
  const weekday = useMemo(() => new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now), [now]);
  const calendarCells = useMemo(() => buildCalendarCells(visibleMonth), [visibleMonth]);
  const calendarNotes = useMemo(() => buildDayNotes(calendarCells.map((cell) => cell.date)), [calendarCells]);
  const monthLabel = useMemo(() => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(visibleMonth), [visibleMonth]);
  const selectedCalendarDate = useMemo(() => parseDateKey(selectedDate) ?? now, [now, selectedDate]);
  const selectedDateLabel = useMemo(() => new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(selectedCalendarDate), [selectedCalendarDate]);
  const selectedNote = useMemo(() => getDayNote(selectedCalendarDate), [selectedCalendarDate]);
  const progress = timer && timer.durationSecs > 0 ? Math.min(1, Math.max(0, timer.remainingSecs / timer.durationSecs)) : 0;
  const mutateTimer = async (item: TimerItem | null, command: string, args: Record<string, unknown> = {}) => {
    if (!item) return;
    await invoke(command, { id: item.id, ...args }).catch(() => {});
  };
  const openStopwatch = () => {
    setView("stopwatch");
    if (stopwatch || creatingStopwatchRef.current) return;
    creatingStopwatchRef.current = true;
    invoke<TimersPayload>("create_timer", { input: { kind: "stopwatch", label: "秒表", durationSecs: 0 } })
      .then((payload) => {
        if (!payload) return;
        setTimer(payload.timers.find((item) => item.kind === "countdown") ?? null);
        setStopwatch(payload.timers.find((item) => item.kind === "stopwatch") ?? null);
      })
      .catch(() => {})
      .finally(() => { creatingStopwatchRef.current = false; });
  };
  const startRename = () => {
    setLabelDraft(stopwatch?.label ?? "");
    setEditingLabel(true);
  };
  const commitRename = () => {
    if (stopwatch) {
      const label = labelDraft.trim();
      if (label && label !== stopwatch.label) void invoke("rename_timer", { id: stopwatch.id, label }).catch(() => {});
    }
    setEditingLabel(false);
  };
  const lapRows = useMemo(() => {
    if (!stopwatch) return [];
    let total = 0;
    return stopwatch.laps.map((interval) => {
      total += interval;
      return { interval, total };
    });
  }, [stopwatch]);

  // 顶部工具条收展：鼠标悬浮到工具区域时展开，移开后延迟收起。
  const openChrome = () => {
    if (chromeCloseTimer.current) {
      window.clearTimeout(chromeCloseTimer.current);
      chromeCloseTimer.current = null;
    }
    setChromeOpen(true);
  };
  const scheduleCloseChrome = () => {
    if (chromeCloseTimer.current) window.clearTimeout(chromeCloseTimer.current);
    chromeCloseTimer.current = window.setTimeout(() => {
      chromeCloseTimer.current = null;
      setChromeOpen(false);
    }, CHROME_COLLAPSE_DELAY_MS);
  };

  return <div
    ref={shellRef}
    className={`timer-shell timer-${display}${chromeOpen ? " is-chrome-open" : ""}`}
    onMouseEnter={openChrome}
    onMouseMove={openChrome}
    onMouseLeave={scheduleCloseChrome}
    onFocusCapture={() => setChromeOpen(true)}
  >
    <header className="timer-header" onMouseDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button,input")) void win.startDragging(); }}>
      <div className="timer-tabs" role="tablist" aria-label="时钟工具模式">
        <button type="button" role="tab" aria-selected={view === "clock"} className={view === "clock" ? "is-active" : ""} onClick={() => setView("clock")}>时钟</button>
        <button type="button" role="tab" aria-selected={view === "countdown"} className={view === "countdown" ? "is-active" : ""} onClick={() => setView("countdown")}>倒计时</button>
        <button type="button" role="tab" aria-selected={view === "stopwatch"} className={view === "stopwatch" ? "is-active" : ""} onClick={openStopwatch}>秒表</button>
        <button type="button" role="tab" aria-selected={view === "calendar"} className={view === "calendar" ? "is-active" : ""} onClick={() => setView("calendar")}>日历</button>
      </div>
      <div className="timer-actions">
        {view === "clock" && <button aria-label="切换时钟样式" data-tooltip="切换样式" onClick={() => setClockFace(clockFace === "digital" ? "analog" : "digital")}><Icon name="Palette" size={14} /></button>}
        {view === "countdown" && <button aria-label="切换倒计时样式" data-tooltip="切换样式" onClick={() => setDisplay(display === "compact" ? "ring" : "compact")}><Icon name="Palette" size={14} /></button>}
        <button aria-label="关闭时钟工具" data-tooltip="关闭" onClick={() => { setChromeOpen(false); void invoke("hide_timer_window"); }}><Icon name="X" size={14} /></button>
      </div>
    </header>
    {view === "clock" ? <main className="timer-clock-view">
      {clockFace === "analog" ? <AnalogFace now={now} /> : <strong className="timer-local-clock-value">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</strong>}
      <span className="timer-date">{now.toLocaleDateString()} · {weekday}{lunarEnabled && lunarDate ? ` · ${lunarDate}` : ""}</span>
    </main> : view === "countdown" ? <main className={`timer-countdown-view${timer?.completed ? " is-complete" : ""}`}>
      <span className="timer-eyebrow">倒计时</span>
      {display === "ring" ? <div className="timer-ring-view"><svg viewBox="0 0 120 120" aria-hidden><circle className="timer-ring-bg" cx="60" cy="60" r={RING_RADIUS} />{progress > 0 && <circle className="timer-ring-fg" cx="60" cy="60" r={RING_RADIUS} style={{ strokeDasharray: RING_CIRCUMFERENCE, strokeDashoffset: RING_CIRCUMFERENCE * (1 - progress) }} />}</svg><strong>{formatTime(value)}</strong></div> : <strong className="timer-primary-value">{formatTime(value)}</strong>}
      {timer && !timer.running && <div className="timer-presets">{[1, 5, 10, 25].map((minutes) => <button key={minutes} onClick={() => void mutateTimer(timer, "set_timer_duration", { seconds: minutes * 60 })}>{minutes}分</button>)}<input aria-label="自定义分钟数" inputMode="numeric" value={customMinutes} onChange={(event) => setCustomMinutes(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))} /><button disabled={!customMinutes} onClick={() => void mutateTimer(timer, "set_timer_duration", { seconds: Math.min(1440, Math.max(1, Number(customMinutes))) * 60 })}>设定</button></div>}
      <div className="timer-controls"><button className="timer-play" onClick={() => void mutateTimer(timer, timer?.running ? "pause_timer" : "start_timer")}><Icon name={timer?.running ? "Pause" : "Play"} size={16} />{timer?.running ? "暂停" : "开始"}</button><button aria-label="增加一分钟" data-tooltip="增加一分钟" onClick={() => void mutateTimer(timer, "add_timer_seconds", { seconds: 60 })}><Icon name="Plus" size={16} /></button><button aria-label="重置倒计时" data-tooltip="重置" onClick={() => void mutateTimer(timer, "reset_timer")}><Icon name="RotateCcw" size={15} /></button></div>
    </main> : view === "stopwatch" ? <main className="timer-stopwatch-view">
      {editingLabel ? <input className="timer-label-input" autoFocus value={labelDraft} maxLength={60} onChange={(event) => setLabelDraft(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") commitRename(); if (event.key === "Escape") { setLabelDraft(stopwatch?.label ?? ""); setEditingLabel(false); } }} /> : <button type="button" className="timer-eyebrow timer-label" title="双击重命名" onDoubleClick={startRename}><Icon name="Pencil" size={11} />{stopwatch?.label ?? "秒表"}</button>}
      <strong className="timer-primary-value">{formatTime(stopwatch?.elapsedSecs ?? 0)}</strong>
      <div className="timer-controls">
        <button className="timer-play" onClick={() => void mutateTimer(stopwatch, stopwatch?.running ? "pause_timer" : "start_timer")}><Icon name={stopwatch?.running ? "Pause" : "Play"} size={16} />{stopwatch?.running ? "暂停" : "开始"}</button>
        <button aria-label="记录分段" data-tooltip="分段" disabled={!stopwatch?.running} onClick={() => void mutateTimer(stopwatch, "add_timer_lap")}><Icon name="Flag" size={15} /></button>
        <button aria-label="重置秒表" data-tooltip="重置" onClick={() => void mutateTimer(stopwatch, "reset_timer")}><Icon name="RotateCcw" size={15} /></button>
      </div>
      {lapRows.length > 0 && <ol className="timer-laps">{lapRows.map((row, index) => <li key={index}><span className="timer-lap-index">分段 {index + 1}</span><span className="timer-lap-interval">+{formatTime(row.interval)}</span><span className="timer-lap-total">{formatTime(row.total)}</span></li>)}</ol>}
    </main> : <main className="timer-calendar-view">
      <div className="calendar-toolbar">
        <button type="button" aria-label="上个月" data-tooltip="上个月" onClick={() => { followsTodayRef.current = false; setVisibleMonth((month) => new Date(month.getFullYear(), month.getMonth() - 1, 1)); }}><Icon name="ChevronLeft" size={15} /></button>
        <strong>{monthLabel}</strong>
        <button type="button" aria-label="下个月" data-tooltip="下个月" onClick={() => { followsTodayRef.current = false; setVisibleMonth((month) => new Date(month.getFullYear(), month.getMonth() + 1, 1)); }}><Icon name="ChevronRight" size={15} /></button>
        <button type="button" className="calendar-today" onClick={() => { const today = new Date(); followsTodayRef.current = true; lastCalendarDayRef.current = dateKey(today); setVisibleMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDate(dateKey(today)); }}>今天</button>
      </div>
      <div className="calendar-weekdays" aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="calendar-grid" role="grid" aria-label={monthLabel}>
        {calendarCells.map((cell) => {
          const key = dateKey(cell.date);
          const isToday = key === dateKey(now);
          const isSelected = key === selectedDate;
          const note = calendarNotes.get(key);
          return <button type="button" key={key} className={`calendar-cell${cell.isCurrentMonth ? "" : " is-outside"}${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}`} role="gridcell" aria-selected={isSelected} aria-label={`${cell.date.toLocaleDateString()}${isToday ? "，今天" : ""}${note ? `，${note.text}` : ""}`} onClick={() => { followsTodayRef.current = false; setSelectedDate(key); if (!cell.isCurrentMonth) setVisibleMonth(new Date(cell.date.getFullYear(), cell.date.getMonth(), 1)); }}>
            <span>{cell.date.getDate()}</span>
            {note ? <small className={note.kind === "festival" ? "note-festival" : "note-term"}>{note.text}</small> : lunarEnabled ? <small>{formatLunarDay(cell.date)}</small> : null}
          </button>;
        })}
      </div>
      <div className="calendar-selection"><strong>{selectedDateLabel}</strong><div className="calendar-selection-meta">{selectedNote && <span className={selectedNote.kind === "festival" ? "note-festival" : "note-term"}>{selectedNote.text}</span>}{lunarEnabled && <span>{formatLunarDate(selectedCalendarDate)}</span>}</div></div>
    </main>}
  </div>;
}

export default TimerTool;
