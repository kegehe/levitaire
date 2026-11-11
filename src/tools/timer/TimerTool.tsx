import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import { applyThemePreferences, getStoredThemePreferences, subscribeThemePreferences } from "../../styles/themePreferences";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import { clampWindowToWorkArea } from "../../utils/panelWindow";
import { buildDayNotes, getDayNote } from "./festivals";
import Hourglass from "./Hourglass";
import { REST_MARK_TEXT, getRestMark } from "./holidays";
import PomodoroPanel from "./PomodoroPanel";
import { formatTime } from "./formatTime";
import { RING_CIRCUMFERENCE, RING_RADIUS, URGENT_SECONDS, ringHeadRotation } from "./ringGeometry";
import "./TimerTool.css";

type View = "clock" | "countdown" | "pomodoro" | "stopwatch" | "calendar";
type Display = "compact" | "ring" | "hourglass";
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
/** 用户自定义的倒计时预设：名称可空，空名时按分钟数生成默认标签。 */
interface CountdownPreset {
  id: string;
  name: string;
  minutes: number;
}
interface CalendarCell { date: Date; isCurrentMonth: boolean; }

const LUNAR_DAY_NAMES = [
  "", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];

const CLOCK_FACE_KEY = "levitaire-timer-clock-style";
/** 倒计时的三种显示样式：数字 / 环形 / 沙漏，切换按钮按这个顺序循环 */
const DISPLAY_ORDER: Display[] = ["compact", "ring", "hourglass"];
/** 切换按钮的提示文案：告诉用户「点一下会变成哪个」，比只说「切换样式」有用 */
const DISPLAY_LABELS: Record<Display, string> = { compact: "数字", ring: "环形", hourglass: "沙漏" };
const DISPLAY_KEY = "levitaire-timer-display";

/** 读取上次使用的显示样式；旧值/脏值一律回退到数字样式 */
function loadStoredDisplay(): Display {
  const stored = localStorage.getItem(DISPLAY_KEY);
  return DISPLAY_ORDER.find((item) => item === stored) ?? "compact";
}
/** 记住上次停留的页签（时钟/倒计时/番茄钟/秒表/日历），重开工具时直接恢复 */
const TIMER_VIEW_KEY = "levitaire-timer-view";
const TIMER_VIEWS: View[] = ["clock", "countdown", "pomodoro", "stopwatch", "calendar"];
const CLOCK_FACE_CENTER = 60;
/** 鼠标移出工具区域后，延迟收起顶部工具条的时间（避免划过边缘时闪烁） */
const CHROME_COLLAPSE_DELAY_MS = 200;
/** 倒计时自定义预设的本地存储键 */
const COUNTDOWN_PRESETS_KEY = "levitaire-timer-presets";
/** 倒计时允许的最大分钟数（与设定按钮的 24 小时上限保持一致） */
const COUNTDOWN_MAX_MINUTES = 1440;
/** 操作失败提示的停留时长：够看清一次结果，又不至于一直占着面板 */
const ERROR_NOTICE_MS = 4000;
/** 删除的连击冷却：双击垃圾桶时第一下删除会让下一行顶到同一位置，
 *  第二下就会落到相邻计时器的删除按钮上。短暂冷却用来吞掉这类误触。 */
const DELETE_COOLDOWN_MS = 400;
/** 计时命令 → 失败文案后缀。命令失败原来被静默吞掉，用户分不清「没点上」还是「出错了」；
 *  未列出的命令统一兜底为「操作失败」，新增命令时记得在这里补一条。 */
const TIMER_COMMAND_FAILURES: Record<string, string> = {
  start_timer: "开始失败",
  pause_timer: "暂停失败",
  reset_timer: "重置失败",
  add_timer_seconds: "加时失败",
  set_timer_duration: "设置时长失败",
  add_timer_lap: "记录分段失败",
};
/** 创建秒表与重命名不经过 mutateTimer，提示来源单独标记，成功时好按来源精确撤销 */
const CREATE_STOPWATCH_SOURCE = "create_stopwatch";
const CREATE_COUNTDOWN_SOURCE = "create_countdown";
const RENAME_SOURCE = "rename_timer";
const COUNTDOWN_RENAME_SOURCE = "rename_countdown";
/** 与后端 MAX_TIMERS 保持一致：列表里新建按钮据此禁用，避免每次点都吃一次后端报错 */
const MAX_TIMERS = 8;
/** 上次选中的倒计时 id：重开工具时仍聚焦同一个，而不是永远回落到列表第一条 */
const ACTIVE_COUNTDOWN_KEY = "levitaire-timer-active-countdown";
/** 不参与拖窗的交互控件：按钮/输入等自己处理点击与输入，mousedown 不能拿来拖窗口。
 *  多倒计时列表整块加入豁免：行本身可点击切换、条目是滚动/点击区域，
 *  否则按下时会被 startDragging 抢走，行点击在真实窗口里根本不触发。 */
const DRAG_EXEMPT_SELECTOR =
  "button, input, textarea, select, a, .timer-countdown-list, [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']";
/** 正在输入文本的控件：Esc 属于它们自己的交互（如取消预设编辑），不能被窗口级 Esc 吞掉 */
const TEXT_ENTRY_SELECTOR =
  "input, textarea, [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']";

/** 复用的农历格式化器：日历一屏 42 格且每秒重渲染，逐格新建开销明显。 */
let lunarFormatter: Intl.DateTimeFormat | null = null;

function getLunarFormatter(): Intl.DateTimeFormat {
  lunarFormatter ??= new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "long", day: "numeric" });
  return lunarFormatter;
}

/** 复用的公历格式化器，行为等价于无参 `Date#toLocaleDateString()`。 */
const DATE_FORMATTER = new Intl.DateTimeFormat();
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("zh-CN", { weekday: "long" });
const MONTH_FORMATTER = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" });
const DAY_LABEL_FORMATTER = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });

function formatLunarDate(date: Date): string {
  try {
    const parts = getLunarFormatter().formatToParts(date);
    const month = parts.find((part) => part.type === "month")?.value ?? "";
    const day = Number(parts.find((part) => part.type === "day")?.value);
    return month && day >= 1 && day <= 30 ? `农历${month}${LUNAR_DAY_NAMES[day]}` : "";
  } catch {
    return "";
  }
}

function formatLunarDay(date: Date): string {
  try {
    const parts = getLunarFormatter().formatToParts(date);
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

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/** 把分钟数限制到倒计时允许的 [1, 1440] 范围。 */
function clampCountdownMinutes(value: number): number {
  const rounded = Math.round(value);
  return Math.min(COUNTDOWN_MAX_MINUTES, Math.max(1, rounded));
}

/** 新建倒计时的默认名称：跳过已被占用的序号。
 *  只按数量命名会在「删掉中间一个再新建」时生成重名标签，列表里两行长得一模一样。 */
function nextCountdownLabel(countdowns: TimerItem[]): string {
  const used = new Set(countdowns.map((item) => item.label));
  let index = countdowns.length + 1;
  while (used.has(`倒计时 ${index}`)) index += 1;
  return `倒计时 ${index}`;
}

/** 预设芯片展示文本：有名称时“名称 N分”，否则退化为“N 分钟”。 */
function presetChipLabel(name: string, minutes: number): string {
  const trimmed = name.trim();
  return trimmed ? `${trimmed} ${minutes}分` : `${minutes} 分钟`;
}

/** 读取本地保存的倒计时预设，忽略损坏/越界条目，保证其余数据可用。 */
function loadCountdownPresets(): CountdownPreset[] {
  try {
    const raw = localStorage.getItem(COUNTDOWN_PRESETS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<CountdownPreset>;
      const minutes = Number(candidate.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > COUNTDOWN_MAX_MINUTES) return [];
      const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 24) : "";
      return [{ id: typeof candidate.id === "string" && candidate.id ? candidate.id : genId(), name, minutes: clampCountdownMinutes(minutes) }];
    });
  } catch {
    return [];
  }
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
  const [view, setView] = useState<View>(() => {
    const stored = localStorage.getItem(TIMER_VIEW_KEY) as View | null;
    return stored && TIMER_VIEWS.includes(stored) ? stored : "clock";
  });
  const [chromeOpen, setChromeOpen] = useState(false);
  const [display, setDisplay] = useState<Display>(loadStoredDisplay);
  const [clockFace, setClockFace] = useState<ClockFace>(() => localStorage.getItem(CLOCK_FACE_KEY) === "analog" ? "analog" : "digital");
  const [now, setNow] = useState(() => new Date());
  /** 后端返回的完整计时器清单：列表按 kind 派生倒计时/秒表，总数还要受 MAX_TIMERS 限制 */
  const [allTimers, setAllTimers] = useState<TimerItem[]>([]);
  const [activeCountdownId, setActiveCountdownId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_COUNTDOWN_KEY),
  );
  const [editingCountdownId, setEditingCountdownId] = useState<string | null>(null);
  const [countdownLabelDraft, setCountdownLabelDraft] = useState("");
  /** 正在删除的 id：按钮据此禁用，配合冷却窗挡住双击连删 */
  const [pendingDeleteIds, setPendingDeleteIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [customMinutes, setCustomMinutes] = useState("5");
  const [savedPresets, setSavedPresets] = useState<CountdownPreset[]>(loadCountdownPresets);
  const [addingPreset, setAddingPreset] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetMinutesDraft, setPresetMinutesDraft] = useState("5");
  const [lunarEnabled, setLunarEnabled] = useState(true);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date()));
  const followsTodayRef = useRef(true);
  const lastCalendarDayRef = useRef(dateKey(new Date()));
  const creatingStopwatchRef = useRef(false);
  const creatingCountdownRef = useRef(false);
  /** 删除请求的同步去重（state 要等下一次渲染才生效，挡不住同一帧的连点） */
  const pendingDeleteIdsRef = useRef<Set<string>>(new Set());
  const lastDeleteAtRef = useRef(0);
  /** 正在提交重命名的 id：阻止 Enter/失焦在响应返回前重复提交同一行 */
  const renamingCountdownIdRef = useRef<string | null>(null);
  const timersHydratedRef = useRef(false);
  /** 本次挂载的初始页签：仅在打开即落在秒表页时自动补齐，避免用户已切走仍后台补建 */
  const initialViewRef = useRef<View>(view);
  const viewRef = useRef<View>(view);
  const shellRef = useRef<HTMLDivElement>(null);
  const chromeCloseTimer = useRef<number | null>(null);

  /** 后端命令失败时的一句提示。**只报错不报成功**：正常操作本身就是可见的反馈，
   *  再加成功提示反而会频繁改变面板高度、挤动下面的按钮。
   *  source 标记这条提示由哪个操作产生，成功时只撤掉同一操作的旧提示 ——
   *  否则「开始失败」会被之后任意一次成功的操作顺带清掉，看起来像开始其实成功了。 */
  const [errorNotice, setErrorNotice] = useState<{ id: number; text: string; source: string } | null>(null);
  const errorNoticeSeq = useRef(0);
  const showErrorNotice = useCallback((text: string, source: string) => {
    // 自增序号而非时间戳：同一毫秒内的两次失败会拿到相同 id，effect 依赖不变就不会重排倒计时
    errorNoticeSeq.current += 1;
    setErrorNotice({ id: errorNoticeSeq.current, text, source });
  }, []);
  const clearErrorNotice = useCallback((source: string) => {
    // 函数式更新：没有命中时返回原值，不触发无意义的重渲染
    setErrorNotice((current) => (current?.source === source ? null : current));
  }, []);
  /** 已删除的计时器 id：后端 id 单调递增、永不复用，过滤掉是安全的。
   *  调度线程可能把「删除前」的快照晚于删除事件送达；若照单全收，已删除的行会重新出现，
   *  而没有运行中的计时器时又等不到下一次广播来纠正，只能靠重启恢复。 */
  const deletedTimerIdsRef = useRef<Set<string>>(new Set());
  const applyTimers = useCallback((next: TimerItem[]) => {
    setAllTimers(
      deletedTimerIdsRef.current.size === 0
        ? next
        : next.filter((item) => !deletedTimerIdsRef.current.has(item.id)),
    );
  }, []);
  useEffect(() => {
    if (!errorNotice) return;
    const timer = window.setTimeout(() => setErrorNotice(null), ERROR_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [errorNotice]);

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
    let disposed = false;
    let unlisten: (() => void) | undefined;
    subscribeThemePreferences()
      .then((stop) => {
        // 订阅在 Promise resolve 前卸载时，cleanup 已经跑过、拿不到 unlisten；
        // 这里必须自己把刚拿到的取消函数调掉，否则监听器永久残留。
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => persistWindowPositionOnMove("time-overlay"), []);
  // 其他工具请求切到番茄钟页签（待办「开始专注」显示本窗口后触发）：
  // 否则窗口会停在记忆的页签上，看不到刚启动的专注倒计时。
  useEffect(() => {
    const un = listen("timer-focus-pomodoro", () => setView("pomodoro"));
    return () => {
      void un.then((fn) => fn());
    };
  }, []);
  // Esc 隐藏窗口（仅隐藏，计时继续）。文本输入控件自己消费 Esc（取消预设编辑），
  // 所以命中输入框时直接放行，避免「想取消编辑却把窗口关了」。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof Element && target.closest(TEXT_ENTRY_SELECTOR)) return;
      setChromeOpen(false);
      void invoke("hide_timer_window");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
      const nextStopwatch = payload.timers.find((item) => item.kind === "stopwatch") ?? null;
      applyTimers(payload.timers);
      // 仅首次数据到达时处理“秒表页签恢复”：
      // 记忆页签为秒表但后端尚无秒表时自动补齐，否则开始/分段等操作会因缺少计时器而静默失效。
      if (timersHydratedRef.current) return;
      timersHydratedRef.current = true;
      // 与手动点击“秒表”页签共用同一把创建锁，避免首屏数据未到时并发创建重复实例。
      if (
        initialViewRef.current !== "stopwatch" ||
        viewRef.current !== "stopwatch" ||
        nextStopwatch ||
        creatingStopwatchRef.current
      ) return;
      // 名额已被倒计时占满：不再发注定失败的创建命令，但要说清为什么秒表页是空的
      if (payload.timers.length >= MAX_TIMERS) {
        showErrorNotice(`最多只能创建 ${MAX_TIMERS} 个计时器`, CREATE_STOPWATCH_SOURCE);
        return;
      }
      creatingStopwatchRef.current = true;
      void invoke<TimersPayload>("create_timer", { input: { kind: "stopwatch", label: "秒表", durationSecs: 0 } })
        .then((created) => {
          if (!created) return;
          clearErrorNotice(CREATE_STOPWATCH_SOURCE);
          applyTimers(created.timers);
        })
        .catch((error) => {
          console.error("create stopwatch failed:", error);
          showErrorNotice("创建秒表失败", CREATE_STOPWATCH_SOURCE);
        })
        .finally(() => { creatingStopwatchRef.current = false; });
    };
    let changedSinceMount = false;
    let cancelled = false;
    invoke<TimersPayload>("get_timers").then((payload) => { if (!cancelled && !changedSinceMount) applyPayload(payload); }).catch(() => {});
    const unlisten = listen<TimersPayload>("timers-changed", (event) => { changedSinceMount = true; applyPayload(event.payload); });
    return () => { cancelled = true; void unlisten.then((stop) => stop()); };
  }, [applyTimers, clearErrorNotice, showErrorNotice]);
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

    // 已下发的窗口尺寸（"宽:高"）。ResizeObserver 的首次回调与同尺寸的重复回调都要被去重吃掉，
    // 否则同一尺寸会被反复 setSize，窗口持续重排。
    let lastSize = "";
    const resizeToContent = () => {
      // 宽高都按面板**实测**下发：面板宽度由 CSS（.timer-shell 的 width: max-content）按内容算，
      // 收起工具条时只剩内容宽度、展开工具条时被页签行撑宽，前端不再写死窗口宽度。
      // 日历页签的 380px 固定在 CSS 的 .timer-shell[data-view="calendar"] 里。
      const rect = shell.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      // 0 = 还没布局（测试环境不做布局），此时下发会把窗口压成一条
      if (!width || !height) return;
      const size = `${width}:${height}`;
      if (size === lastSize) return;
      lastSize = size;
      win.setSize(new LogicalSize(width, height)).catch(() => {});
      // 面板变宽变高（展开工具条、切页签、切换倒计时样式）后，贴着屏幕右/下沿的窗口会有一部分
      // 跑到工作区外，而本窗口是无边框置顶窗、没有滚动条，出屏部分直接看不到。
      // 被挤回工作区后窗口不会自己回落，但那一侧的余量正好等于这次撑开的差额，再悬停一次即到位，
      // 不会持续漂走（位置记忆由 Rust 侧的 clamp 抑制写回，见 clamp_window_to_workarea）。
      clampWindowToWorkArea(width, height);
    };

    resizeToContent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [view, win]);
  useEffect(() => { localStorage.setItem(DISPLAY_KEY, display); }, [display]);
  useEffect(() => { localStorage.setItem(CLOCK_FACE_KEY, clockFace); }, [clockFace]);
  useEffect(() => { localStorage.setItem(COUNTDOWN_PRESETS_KEY, JSON.stringify(savedPresets)); }, [savedPresets]);
  useEffect(() => {
    viewRef.current = view;
    localStorage.setItem(TIMER_VIEW_KEY, view);
  }, [view]);

  /** 倒计时与秒表都从同一份清单派生：后端允许同时存在多个同类型计时器，
   *  界面只把「当前选中的倒计时」铺到大数字上，其余在列表里并排运行。 */
  const countdowns = useMemo(() => allTimers.filter((item) => item.kind === "countdown"), [allTimers]);
  const stopwatch = useMemo(() => allTimers.find((item) => item.kind === "stopwatch") ?? null, [allTimers]);
  /** 选中的 id 可能已被删除/尚未恢复：逐级回落到列表第一条，避免大数字区空着 */
  const timer = useMemo(
    () => countdowns.find((item) => item.id === activeCountdownId) ?? countdowns[0] ?? null,
    [activeCountdownId, countdowns],
  );
  // 选中的计时器已不存在（被删除 / 上次的 id 失效）时，落回列表第一条并同步存储，
  // 否则下次打开还会拿着一个永远匹配不到的旧 id。
  useEffect(() => {
    if (countdowns.length === 0) return;
    if (countdowns.some((item) => item.id === activeCountdownId)) return;
    setActiveCountdownId(countdowns[0].id);
  }, [activeCountdownId, countdowns]);
  useEffect(() => {
    if (activeCountdownId) localStorage.setItem(ACTIVE_COUNTDOWN_KEY, activeCountdownId);
  }, [activeCountdownId]);
  const remaining = timer?.remainingSecs ?? 0;
  /** 强调态：剩余进入最后 URGENT_SECONDS 秒且计时正在运行，此时环与数字转警示色并逐秒跳动 */
  const urgent = Boolean(timer?.running) && remaining > 0 && remaining <= URGENT_SECONDS;
  /** 点一下样式按钮会切到的下一个样式（提示文案用） */
  const nextDisplay = DISPLAY_ORDER[(DISPLAY_ORDER.indexOf(display) + 1) % DISPLAY_ORDER.length];
  const lunarDate = useMemo(() => formatLunarDate(now), [now]);
  const weekday = useMemo(() => WEEKDAY_FORMATTER.format(now), [now]);
  const calendarCells = useMemo(() => buildCalendarCells(visibleMonth), [visibleMonth]);
  const calendarNotes = useMemo(() => buildDayNotes(calendarCells.map((cell) => cell.date)), [calendarCells]);
  const todayKey = dateKey(now);
  const monthLabel = useMemo(() => MONTH_FORMATTER.format(visibleMonth), [visibleMonth]);
  const selectedCalendarDate = useMemo(() => parseDateKey(selectedDate) ?? now, [now, selectedDate]);
  const selectedDateLabel = useMemo(() => DAY_LABEL_FORMATTER.format(selectedCalendarDate), [selectedCalendarDate]);
  const selectedNote = useMemo(() => getDayNote(selectedCalendarDate), [selectedCalendarDate]);
  const progress = timer && timer.durationSecs > 0 ? Math.min(1, Math.max(0, timer.remainingSecs / timer.durationSecs)) : 0;
  const mutateTimer = async (item: TimerItem | null, command: string, args: Record<string, unknown> = {}) => {
    if (!item) {
      // 秒表的控制条无条件渲染，创建还没返回时点按钮会落进这里：
      // 明确提示比静默无反应好，否则用户只会以为按钮坏了。
      showErrorNotice("计时器尚未就绪", "timer-not-ready");
      return;
    }
    const prefix = item.kind === "stopwatch" ? "秒表" : "倒计时";
    // 来源带计时器类型：倒计时的失败不该被秒表的一次成功顺带清掉
    const source = `${item.kind}:${command}`;
    try {
      await invoke(command, { id: item.id, ...args });
      clearErrorNotice(source);
    } catch (error) {
      console.error(`timer command failed: ${command}`, error);
      showErrorNotice(`${prefix}${TIMER_COMMAND_FAILURES[command] ?? "操作失败"}`, source);
    }
  };
  const openStopwatch = () => {
    setView("stopwatch");
    if (stopwatch || creatingStopwatchRef.current) return;
    // 秒表与倒计时共用同一份 8 个名额：满了就别再发一条注定失败的创建命令
    if (allTimers.length >= MAX_TIMERS) {
      showErrorNotice(`最多只能创建 ${MAX_TIMERS} 个计时器`, CREATE_STOPWATCH_SOURCE);
      return;
    }
    creatingStopwatchRef.current = true;
    invoke<TimersPayload>("create_timer", { input: { kind: "stopwatch", label: "秒表", durationSecs: 0 } })
      .then((payload) => {
        if (!payload) return;
        clearErrorNotice(CREATE_STOPWATCH_SOURCE);
        applyTimers(payload.timers);
      })
      .catch((error) => {
        console.error("create stopwatch failed:", error);
        showErrorNotice("创建秒表失败", CREATE_STOPWATCH_SOURCE);
      })
      .finally(() => { creatingStopwatchRef.current = false; });
  };
  const startRename = () => {
    setLabelDraft(stopwatch?.label ?? "");
    setEditingLabel(true);
  };
  const commitRename = () => {
    if (stopwatch) {
      const label = labelDraft.trim();
      if (label && label !== stopwatch.label) {
        void invoke("rename_timer", { id: stopwatch.id, label })
          .then(() => clearErrorNotice(RENAME_SOURCE))
          .catch((error) => {
            console.error("rename timer failed:", error);
            showErrorNotice("秒表重命名失败", RENAME_SOURCE);
          });
      }
    }
    setEditingLabel(false);
  };
  /** 新建倒计时：默认 5 分钟、按未被占用的序号命名，创建后立刻聚焦到它，用户可直接开始或改名。 */
  const createCountdown = () => {
    if (creatingCountdownRef.current) return;
    if (allTimers.length >= MAX_TIMERS) {
      showErrorNotice(`最多只能创建 ${MAX_TIMERS} 个计时器`, CREATE_COUNTDOWN_SOURCE);
      return;
    }
    creatingCountdownRef.current = true;
    invoke<TimersPayload>("create_timer", {
      input: { kind: "countdown", label: nextCountdownLabel(countdowns), durationSecs: 300 },
    })
      .then((payload) => {
        if (!payload) return;
        clearErrorNotice(CREATE_COUNTDOWN_SOURCE);
        applyTimers(payload.timers);
        // 后端把新计时器追加在末尾：反向找第一个倒计时即是刚创建的那个
        const created = [...payload.timers].reverse().find((item) => item.kind === "countdown");
        if (created) setActiveCountdownId(created.id);
      })
      .catch((error) => {
        console.error("create countdown failed:", error);
        showErrorNotice("创建倒计时失败", CREATE_COUNTDOWN_SOURCE);
      })
      .finally(() => { creatingCountdownRef.current = false; });
  };
  const startCountdownRename = (item: TimerItem) => {
    setActiveCountdownId(item.id);
    setCountdownLabelDraft(item.label);
    setEditingCountdownId(item.id);
  };
  const commitCountdownRename = () => {
    const target = countdowns.find((item) => item.id === editingCountdownId);
    if (!target) {
      setEditingCountdownId(null);
      return;
    }
    const label = countdownLabelDraft.trim();
    if (!label || label === target.label) {
      setEditingCountdownId((current) => (current === target.id ? null : current));
      return;
    }
    // 列表行控件的可访问名称直接由标签拼成，重名会让读屏与自动化无法区分两行；
    // 默认命名已经避重，这里把用户手动改名的入口也一并挡住。
    // 拒绝时保留编辑器与草稿，用户可以直接改正，不必重新双击、重新输入。
    if (countdowns.some((item) => item.id !== target.id && item.label === label)) {
      showErrorNotice("已有同名倒计时", COUNTDOWN_RENAME_SOURCE);
      return;
    }
    if (renamingCountdownIdRef.current === target.id) return;
    renamingCountdownIdRef.current = target.id;
    void invoke("rename_timer", { id: target.id, label })
      .then(() => {
        clearErrorNotice(COUNTDOWN_RENAME_SOURCE);
        // 只关这一行的编辑器：等待响应期间用户可能已经转去改另一行
        setEditingCountdownId((current) => (current === target.id ? null : current));
      })
      .catch((error) => {
        // 失败同样保留编辑器与草稿，用户可直接重试
        console.error("rename countdown failed:", error);
        showErrorNotice("倒计时重命名失败", COUNTDOWN_RENAME_SOURCE);
      })
      .finally(() => {
        if (renamingCountdownIdRef.current === target.id) renamingCountdownIdRef.current = null;
      });
  };
  /** 删除走独立路径而不是 mutateTimer：成功后把 id 记入过滤集，
   *  迟到的旧快照不会再把这一行带回来。 */
  const deleteCountdown = async (event: ReactMouseEvent<HTMLButtonElement>, item: TimerItem) => {
    // 行内按钮不改变当前选中项：删除失败时大数字也不该被切到这一行
    event.stopPropagation();
    if (pendingDeleteIdsRef.current.has(item.id)) return;
    // 双击垃圾桶时第一下删除会让下一行顶到同一坐标，冷却窗吞掉第二下，避免误删相邻项
    const now = Date.now();
    if (now - lastDeleteAtRef.current < DELETE_COOLDOWN_MS) return;
    lastDeleteAtRef.current = now;
    pendingDeleteIdsRef.current.add(item.id);
    setPendingDeleteIds(new Set(pendingDeleteIdsRef.current));
    if (editingCountdownId === item.id) setEditingCountdownId(null);
    const source = `${item.kind}:delete_timer`;
    try {
      const payload = await invoke<TimersPayload>("delete_timer", { id: item.id });
      deletedTimerIdsRef.current.add(item.id);
      if (payload) applyTimers(payload.timers);
      clearErrorNotice(source);
    } catch (error) {
      console.error("delete countdown failed:", error);
      showErrorNotice("倒计时删除失败", source);
    } finally {
      pendingDeleteIdsRef.current.delete(item.id);
      setPendingDeleteIds(new Set(pendingDeleteIdsRef.current));
    }
  };
  const lapRows = useMemo(() => {
    if (!stopwatch) return [];
    let total = 0;
    return stopwatch.laps.map((interval) => {
      total += interval;
      return { interval, total };
    });
  }, [stopwatch]);

  /** 套用某个分钟数：同步到自定义输入框再写入倒计时，保证书签保存时默认值与生效时长一致。 */
  const applyDurationMinutes = (minutes: number) => {
    setCustomMinutes(String(minutes));
    if (timer) void mutateTimer(timer, "set_timer_duration", { seconds: minutes * 60 });
  };
  const applyPreset = (preset: CountdownPreset) => {
    applyDurationMinutes(preset.minutes);
  };
  /** 打开“存为预设”编辑行：以自定义框或当前倒计时时长作为默认分钟数。 */
  const startAddPreset = () => {
    if (addingPreset) return;
    const fallback = timer && timer.durationSecs > 0 ? clampCountdownMinutes(timer.durationSecs / 60) : 5;
    const typed = Number(customMinutes);
    const initial = Number.isInteger(typed) && typed >= 1 ? Math.min(COUNTDOWN_MAX_MINUTES, typed) : fallback;
    setPresetNameDraft("");
    setPresetMinutesDraft(String(initial));
    setAddingPreset(true);
  };
  const commitAddPreset = () => {
    const rawMinutes = presetMinutesDraft.trim();
    if (!rawMinutes) return; // 空分钟数视为无效，保持编辑状态，避免静默保存成 1 分钟
    const minutes = clampCountdownMinutes(Number(rawMinutes));
    const name = presetNameDraft.trim().slice(0, 24);
    setSavedPresets((current) => {
      // 同名预设视为同一个方案：重复保存仅更新时长；未命名预设按分钟数归并。
      const key = name ? `name:${name}` : `time:${minutes}`;
      const existingIndex = current.findIndex((preset) => (preset.name ? `name:${preset.name}` : `time:${preset.minutes}`) === key);
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = { ...next[existingIndex], name, minutes };
        return next;
      }
      return [...current, { id: genId(), name, minutes }];
    });
    setAddingPreset(false);
  };
  const cancelAddPreset = () => {
    setAddingPreset(false);
    setPresetNameDraft("");
  };
  const removePreset = (id: string) => {
    setSavedPresets((current) => current.filter((preset) => preset.id !== id));
  };

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

  // 整窗拖拽：挂在卡片根节点上，除交互控件外的任意位置按下都能移动窗口。
  // 之前只挂在顶部工具条上，而工具条从左到右被页签按钮占满，真正的空白只剩
  // 页签与操作区之间那一条窄缝——表现就是「只有右边一小条能拖，左边拖不动」；
  // 工具条收起时（默认态）更是完全没有可拖区域。
  const startWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // 判定用 Element 而不是 HTMLElement：图标渲染的是 <svg>，按下位置落在 SVG
    // 子节点上时 instanceof HTMLElement 为 false，会把「按钮内部」误判成可拖区域
    // （Element 才同时覆盖 HTMLElement 与 SVGElement，closest 也定义在 Element 上）。
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(DRAG_EXEMPT_SELECTOR)) return;
    // 拦掉默认行为，避免拖拽过程中触发文字选区
    event.preventDefault();
    void win.startDragging().catch(() => {});
  };

  return <div
    ref={shellRef}
    // 修饰类必须带 `display-` 前缀：`.timer-${display}` 曾生成 `timer-hourglass`，
    // 与沙漏图形的 `.timer-hourglass` 撞名，把整块面板压成 112×112（详见 TimerTool.css 的说明）。
    // data-view 给 CSS 用（日历页签固定 380px 宽），不加类名——面板的类名集合被测试钉死为
    // 「timer-shell + 显示样式修饰类」。
    className={`timer-shell timer-display-${display}${chromeOpen ? " is-chrome-open" : ""}`}
    data-view={view}
    onMouseDown={startWindowDrag}
    onMouseEnter={openChrome}
    onMouseMove={openChrome}
    onMouseLeave={scheduleCloseChrome}
    onFocusCapture={() => setChromeOpen(true)}
  >
    <header className="timer-header">
      <div className="timer-tabs" role="tablist" aria-label="时间工具模式">
        <button type="button" role="tab" aria-selected={view === "clock"} className={view === "clock" ? "is-active" : ""} onClick={() => setView("clock")}>时钟</button>
        <button type="button" role="tab" aria-selected={view === "countdown"} className={view === "countdown" ? "is-active" : ""} onClick={() => setView("countdown")}>倒计时</button>
        <button type="button" role="tab" aria-selected={view === "pomodoro"} className={view === "pomodoro" ? "is-active" : ""} onClick={() => setView("pomodoro")}>番茄钟</button>
        <button type="button" role="tab" aria-selected={view === "stopwatch"} className={view === "stopwatch" ? "is-active" : ""} onClick={openStopwatch}>秒表</button>
        <button type="button" role="tab" aria-selected={view === "calendar"} className={view === "calendar" ? "is-active" : ""} onClick={() => setView("calendar")}>日历</button>
      </div>
      <div className="timer-actions">
        {view === "clock" && <button aria-label="切换时钟样式" data-tooltip="切换样式" onClick={() => setClockFace(clockFace === "digital" ? "analog" : "digital")}><Icon name="Palette" size={14} /></button>}
        {view === "countdown" && <button aria-label="切换倒计时样式" data-tooltip={`切换为${DISPLAY_LABELS[nextDisplay]}`} onClick={() => setDisplay(nextDisplay)}><Icon name="Palette" size={14} /></button>}
        <button aria-label="关闭时间工具" data-tooltip="关闭" onClick={() => { setChromeOpen(false); void invoke("hide_timer_window"); }}><Icon name="X" size={14} /></button>
      </div>
    </header>
    {/* 失败提示固定排在工具条下方：各视图内容结构不同，挂在视图内部会随页签消失/挪位 */}
    {errorNotice && <p key={errorNotice.id} className="timer-error-notice" role="alert">
      <Icon name="AlertCircle" size={12} />
      <span>{errorNotice.text}</span>
    </p>}
    {view === "clock" ? <main className="timer-clock-view">
      {clockFace === "analog" ? <AnalogFace now={now} /> : <strong className="timer-local-clock-value">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</strong>}
      <span className="timer-date">{DATE_FORMATTER.format(now)} · {weekday}{lunarEnabled && lunarDate ? ` · ${lunarDate}` : ""}</span>
    </main> : view === "countdown" ? <main className={`timer-countdown-view${timer?.completed ? " is-complete" : ""}${timer?.running ? " is-running" : ""}${urgent ? " is-urgent" : ""}`}>
      {/* 没有任何倒计时时（例如只保留了一个秒表）不渲染大数字与控制条：
          00:00 加一组点不动的按钮会让人以为计时器坏了，列表里的「新建」才是出口。 */}
      {timer && <>
      <span className="timer-eyebrow timer-countdown-label" title={timer.label}>{timer.label}</span>
      {display === "ring" ? <div className="timer-ring-view" style={{ "--ring-from": String(RING_CIRCUMFERENCE) } as CSSProperties}>
        <svg viewBox="0 0 120 120" aria-hidden>
          <circle className="timer-ring-bg" cx="60" cy="60" r={RING_RADIUS} />
          {/* 进度为 0 时不画前景弧：stroke-linecap: round 会把零长度弧渲染成 12 点方向的圆点 */}
          {progress > 0 && <circle className="timer-ring-fg" cx="60" cy="60" r={RING_RADIUS} style={{ strokeDasharray: RING_CIRCUMFERENCE, strokeDashoffset: RING_CIRCUMFERENCE * (1 - progress) }} />}
          {/* 环头珠子贴在弧尖上随剩余进度绕圈（旋转量见 ringHeadRotation：要补回外层
              svg 自己的 -90°，否则珠子会落后弧尖 90°）。只在运行时渲染——暂停时珠子
              消失，与运行状态一眼可分。 */}
          {timer?.running && progress > 0 && <g className="timer-ring-head" style={{ transform: `rotate(${ringHeadRotation(progress)}deg)` }}><circle cx="60" cy="10" r="4.2" /></g>}
        </svg>
        {/* key=剩余秒数：每秒重挂一次，重放数字跳动动画，让「减少」被看见 */}
        <strong key={remaining}>{formatTime(remaining)}</strong>
      </div> : display === "hourglass" ? <>
        {/* 沙漏样式：沙量即剩余时间（面积等比，见 hourglassGeometry），数字排在瓶下方 */}
        <Hourglass progress={progress} running={Boolean(timer?.running)} />
        <strong key={remaining} className="timer-primary-value timer-hg-value">{formatTime(remaining)}</strong>
      </> : <>
        <strong key={remaining} className="timer-primary-value">{formatTime(remaining)}</strong>
        {/* 紧凑样式没有环，用一条进度条承载同样的「剩余比例」信息 */}
        <span className="timer-progress" aria-hidden><span className="timer-progress-fill" style={{ transform: `scaleX(${progress})` }} /></span>
      </>}
      {timer && !timer.running && <div className="timer-presets">{[1, 5, 10, 25].map((minutes) => <button key={minutes} onClick={() => applyDurationMinutes(minutes)}>{minutes}分</button>)}<input aria-label="自定义分钟数" inputMode="numeric" value={customMinutes} onChange={(event) => setCustomMinutes(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))} /><button disabled={!customMinutes} onClick={() => void mutateTimer(timer, "set_timer_duration", { seconds: clampCountdownMinutes(Number(customMinutes)) * 60 })}>设定</button><button type="button" className="timer-preset-save" aria-label="保存为预设" data-tooltip="存为预设" onClick={startAddPreset}><Icon name="Bookmark" size={12} /></button></div>}
      {timer && !timer.running && (savedPresets.length > 0 || addingPreset) && <div className="timer-my-presets">
        {addingPreset && <div className="timer-preset-editor">
          <input autoFocus className="timer-preset-name" aria-label="预设名称" placeholder="名称，如 学习" value={presetNameDraft} maxLength={24} onChange={(event) => setPresetNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commitAddPreset(); if (event.key === "Escape") cancelAddPreset(); }} />
          <span className="timer-preset-duration"><input aria-label="预设分钟数" inputMode="numeric" value={presetMinutesDraft} onChange={(event) => setPresetMinutesDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))} onKeyDown={(event) => { if (event.key === "Enter") commitAddPreset(); if (event.key === "Escape") cancelAddPreset(); }} /><em>分</em></span>
          <button type="button" aria-label="保存预设" data-tooltip="保存" disabled={!presetMinutesDraft} onClick={commitAddPreset}><Icon name="Check" size={12} /></button>
          <button type="button" aria-label="取消保存" data-tooltip="取消" onClick={cancelAddPreset}><Icon name="X" size={12} /></button>
        </div>}
        {savedPresets.map((preset) => <span key={preset.id} className="timer-preset-chip">
          <button type="button" title={`应用预设：${presetChipLabel(preset.name, preset.minutes)}`} onClick={() => applyPreset(preset)}>{presetChipLabel(preset.name, preset.minutes)}</button>
          <button type="button" className="timer-preset-remove" aria-label={`删除${presetChipLabel(preset.name, preset.minutes)}`} onClick={() => removePreset(preset.id)}><Icon name="X" size={10} /></button>
        </span>)}
      </div>}
      <div className="timer-controls"><button className="timer-play" onClick={() => void mutateTimer(timer, timer.running ? "pause_timer" : "start_timer")}><Icon name={timer.running ? "Pause" : "Play"} size={16} />{timer.running ? "暂停" : "开始"}</button><button aria-label="增加一分钟" data-tooltip="增加一分钟" onClick={() => void mutateTimer(timer, "add_timer_seconds", { seconds: 60 })}><Icon name="Plus" size={16} /></button><button aria-label="重置倒计时" data-tooltip="重置" onClick={() => void mutateTimer(timer, "reset_timer")}><Icon name="RotateCcw" size={15} /></button></div>
      </>}
      {/* 多计时器列表：后端可同时推进多个倒计时，大数字只显示当前选中的那个，
          其余在这里各自显示剩余时间，并可直接开始/暂停、改名、删除。 */}
      <div className="timer-countdown-list">
        <div className="timer-countdown-list-head">
          <span>全部倒计时</span>
          <button type="button" aria-label="新建倒计时" title={allTimers.length >= MAX_TIMERS ? `最多 ${MAX_TIMERS} 个计时器` : undefined} data-tooltip="新建" disabled={allTimers.length >= MAX_TIMERS} onClick={createCountdown}><Icon name="Plus" size={12} /></button>
        </div>
        {countdowns.length === 0 ? <p className="timer-countdown-empty">还没有倒计时</p> : <ul aria-label="倒计时列表">
          {countdowns.map((item) => <li key={item.id} className={`timer-countdown-item${item.id === timer?.id ? " is-active" : ""}${item.running ? " is-running" : ""}`} onClick={() => setActiveCountdownId(item.id)}>
            {editingCountdownId === item.id ? <input
              autoFocus
              className="timer-countdown-input"
              aria-label={`重命名${item.label}`}
              value={countdownLabelDraft}
              maxLength={60}
              onChange={(event) => setCountdownLabelDraft(event.target.value)}
              onBlur={commitCountdownRename}
              onKeyDown={(event) => {
                // 中文输入法组合态下的 Enter/Escape 是候选词操作，不能当成提交/取消。
                // keyCode 229 是部分输入法在结束组合时仍上报的兼容值。
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") commitCountdownRename();
                if (event.key === "Escape") { setCountdownLabelDraft(item.label); setEditingCountdownId(null); }
              }}
            /> : <button type="button" className="timer-countdown-name" title={`${item.label}（双击重命名）`} aria-current={item.id === timer?.id ? "true" : undefined} onClick={() => setActiveCountdownId(item.id)} onDoubleClick={() => startCountdownRename(item)}>
              <span className="timer-countdown-name-text">{item.label}</span>
            </button>}
            <span className={`timer-countdown-time${item.completed ? " is-complete" : ""}`}>{formatTime(item.remainingSecs)}</span>
            <button type="button" className="timer-countdown-control" aria-label={`${item.running ? "暂停" : "开始"}${item.label}`} title={item.running ? "暂停" : "开始"} onClick={(event) => { event.stopPropagation(); void mutateTimer(item, item.running ? "pause_timer" : "start_timer"); }}><Icon name={item.running ? "Pause" : "Play"} size={12} /></button>
            <button type="button" className="timer-countdown-control" aria-label={`删除${item.label}`} title={pendingDeleteIds.has(item.id) ? "正在删除" : allTimers.length <= 1 ? "至少保留一个计时器" : "删除"} disabled={allTimers.length <= 1 || pendingDeleteIds.has(item.id)} onClick={(event) => void deleteCountdown(event, item)}><Icon name="Trash2" size={12} /></button>
          </li>)}
        </ul>}
      </div>
    </main> : view === "pomodoro" ? <PomodoroPanel /> : view === "stopwatch" ? <main className="timer-stopwatch-view">
      {/* 没有秒表时（创建失败，或 8 个名额已被倒计时占满）不渲染 00:00 与无效控制条，
          否则用户只会反复点到「计时器尚未就绪」，看不出真正原因。 */}
      {stopwatch ? <>
      {editingLabel ? <input className="timer-label-input" autoFocus value={labelDraft} maxLength={60} onChange={(event) => setLabelDraft(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") commitRename(); if (event.key === "Escape") { setLabelDraft(stopwatch?.label ?? ""); setEditingLabel(false); } }} /> : <button type="button" className="timer-eyebrow timer-label" title="双击重命名" onDoubleClick={startRename}><Icon name="Pencil" size={11} /><span className="timer-label-text">{stopwatch.label}</span></button>}
      <strong className="timer-primary-value">{formatTime(stopwatch.elapsedSecs)}</strong>
      <div className="timer-controls">
        <button className="timer-play" onClick={() => void mutateTimer(stopwatch, stopwatch.running ? "pause_timer" : "start_timer")}><Icon name={stopwatch.running ? "Pause" : "Play"} size={16} />{stopwatch.running ? "暂停" : "开始"}</button>
        <button aria-label="记录分段" data-tooltip="分段" disabled={!stopwatch.running} onClick={() => void mutateTimer(stopwatch, "add_timer_lap")}><Icon name="Flag" size={15} /></button>
        <button aria-label="重置秒表" data-tooltip="重置" onClick={() => void mutateTimer(stopwatch, "reset_timer")}><Icon name="RotateCcw" size={15} /></button>
      </div>
      {lapRows.length > 0 && <ol className="timer-laps">{lapRows.map((row, index) => <li key={index}><span className="timer-lap-index">分段 {index + 1}</span><span className="timer-lap-interval">+{formatTime(row.interval)}</span><span className="timer-lap-total">{formatTime(row.total)}</span></li>)}</ol>}
      </> : <div className="timer-stopwatch-empty">
        <span>{allTimers.length >= MAX_TIMERS
          ? `秒表尚未创建：最多 ${MAX_TIMERS} 个计时器，请先在倒计时列表删除一个`
          : "秒表尚未创建"}</span>
        {/* 空态必须带一个可操作入口：错误提示 4 秒后消失，不能只留下一个死页面 */}
        {allTimers.length >= MAX_TIMERS
          ? <button type="button" onClick={() => setView("countdown")}>去倒计时列表管理</button>
          : <button type="button" onClick={openStopwatch}>创建秒表</button>}
      </div>}
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
          const isToday = key === todayKey;
          const isSelected = key === selectedDate;
          const note = calendarNotes.get(key);
          // 休 / 班角标：仅法定放假日与调休上班日有值，普通周末与工作日为 null
          const restMark = getRestMark(cell.date);
          return <button type="button" key={key} className={`calendar-cell${cell.isCurrentMonth ? "" : " is-outside"}${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}`} role="gridcell" aria-selected={isSelected} aria-label={`${DATE_FORMATTER.format(cell.date)}${isToday ? "，今天" : ""}${note ? `，${note.text}` : ""}${restMark ? `，${REST_MARK_TEXT[restMark]}` : ""}`} onClick={() => { followsTodayRef.current = false; setSelectedDate(key); if (!cell.isCurrentMonth) setVisibleMonth(new Date(cell.date.getFullYear(), cell.date.getMonth(), 1)); }}>
            <span>{cell.date.getDate()}</span>
            {restMark && <small className={`calendar-rest rest-${restMark}`} aria-hidden="true">{REST_MARK_TEXT[restMark]}</small>}
            {note ? <small className={note.kind === "festival" ? "note-festival" : "note-term"}>{note.text}</small> : lunarEnabled ? <small>{formatLunarDay(cell.date)}</small> : null}
          </button>;
        })}
      </div>
      <div className="calendar-selection"><strong>{selectedDateLabel}</strong><div className="calendar-selection-meta">{selectedNote && <span className={selectedNote.kind === "festival" ? "note-festival" : "note-term"}>{selectedNote.text}</span>}{lunarEnabled && <span>{formatLunarDate(selectedCalendarDate)}</span>}</div></div>
    </main>}
  </div>;
}

export default TimerTool;
