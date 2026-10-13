import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { monitorFromPoint } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import Icon from "../../components/Icon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import "./QuickInputTool.css";

/** 转盘条目：预设词与剪贴板历史统一结构 */
interface WheelItem {
  /** 展示标签 */
  label: string;
  /** 选中后输入的完整文本（分组条目可为空串） */
  text: string;
  /** 是否为剪贴板历史项（历史项用不同颜色区分） */
  isHistory: boolean;
  /** 是否为收藏的历史项（收藏项固定在历史区最前，用星标区分） */
  isFavorite?: boolean;
  /**
   * 子转盘条目（仅预设片段支持分组）。非空 = 父级扇区：
   * 点击/按住确认落在其上时进入子转盘（方案 2 · 整盘置换），不输入文本。
   */
  children?: WheelItem[];
}

/** 子转盘导航栈的一级：换级时压入的父级标签与其所在层条目 */
interface NavLevel {
  label: string;
  items: WheelItem[];
}

/**
 * 片段 JSON 单条 → 转盘条目（归一化）：
 * - 带 children 的条目为父级分组，允许空 text（转盘中点击进入子级，不输入文本）；
 * - 子项里无 text 的条目被剔除，children 全部无效时视同普通条目；
 * - 无 text 且无有效 children 的条目无效，返回 null。
 */
export function snippetToWheelItem(snippet: {
  label?: string;
  text?: string;
  children?: Array<{ label?: string; text?: string }>;
}): WheelItem | null {
  const children = (snippet.children ?? [])
    .filter((child): child is { label?: string; text: string } => !!child.text)
    .map((child) => ({
      label: child.label || child.text.slice(0, 20),
      text: child.text,
      isHistory: false,
    }));
  if (!snippet.text && !children.length) return null;
  return {
    label: snippet.label || snippet.text?.slice(0, 20) || "未命名分组",
    text: snippet.text ?? "",
    isHistory: false,
    children: children.length ? children : undefined,
  };
}

/** 后端 quick-input-start / quick-input-mouse-move 事件 payload */
interface CoordPayload {
  x: number;
  y: number;
  generation?: number;
}

interface QuickInputState {
  active: boolean;
  x: number;
  y: number;
  generation: number;
  holdConfirmPending?: boolean;
  holdConfirmX?: number;
  holdConfirmY?: number;
}

/** 后端 quick-input-confirm 事件 payload */
interface ConfirmPayload {
  selectedIndex: number | null;
  generation?: number;
}

/** 后端收到按住模式 keyup 后，请求前端按该瞬间鼠标位置结算扇区。 */
interface HoldConfirmRequestPayload {
  x: number;
  y: number;
  generation: number;
}

/** 窗口逻辑尺寸（CSS px，与后端 ensure_quick_input_window 的 inner_size 一致；物理尺寸 = 值 × scale） */
const WINDOW_SIZE = 320;
/** 转盘外半径（逻辑像素，按 scale 1 设计；高 DPI 下窗口/图形随系统缩放自动放大） */
const WHEEL_RADIUS = 130;
/** 中心死区半径（逻辑像素）：鼠标在此范围内不选中任何扇区。move 坐标为物理像素，命中判断需 ×scale 换算 */
const DEAD_ZONE = 18;
/** 扇区类型标记图标尺寸（逻辑像素） */
const TYPE_ICON_SIZE = 12;
/** 标签环和图标环分离，避免图标覆盖任何文字。 */
const LABEL_RING_RADIUS = 80;
const ICON_RING_RADIUS = 119;
const LABEL_FONT_SIZE = 12.5;
const LABEL_ARC_FILL_RATIO = 0.82;
const TANGENTIAL_LAYOUT_THRESHOLD = 4;
const TEXT_STROKE_PADDING = 2;
const MIN_TYPE_ICON_SIZE = 5;
/** 中心胶囊：字号（方案 A：圆角胶囊替代放大中心圆，完整展示高亮标签） */
const CAPSULE_FONT_SIZE = 12;
/** 中心胶囊：单侧水平内边距 */
const CAPSULE_PADDING_X = 13;
/** 中心胶囊：高度 */
const CAPSULE_HEIGHT = 28;
/** 中心胶囊：圆角半径（= 高度一半，全圆角） */
const CAPSULE_RADIUS = 14;
/** 中心胶囊：最大宽度，超出按宽度截断追加省略号 */
const CAPSULE_MAX_WIDTH = 180;
/** 中心胶囊：最小宽度，短标签时保持视觉稳定 */
const CAPSULE_MIN_WIDTH = 56;
/** 少量扇区时的标签绝对宽度上限。 */
const MAX_LABEL_WIDTH = 125;

/**
 * 判断字符是否为全宽（CJK）字符，用于按比例估算文本渲染宽度。
 * 覆盖汉字、全角标点、假名、谚文等常见宽字符区间。
 */
function isWideChar(ch: string): boolean {
  return /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿＀-￯]/.test(ch);
}

/** 估算文本渲染宽度（逻辑像素）：全宽字符按 1em，其余按 0.55em */
export function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    width += isWideChar(ch) ? fontSize : fontSize * 0.55;
  }
  return width;
}

/** 将文本按最大宽度截断，超出时在末尾追加省略号；适合中英混排的宽度估算 */
export function fitText(text: string, maxWidth: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisW = textWidth(ellipsis, fontSize);
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = textWidth(ch, fontSize);
    if (width + w + ellipsisW > maxWidth) break;
    width += w;
    out += ch;
  }
  return out + ellipsis;
}

/**
 * 中心胶囊几何：根据高亮标签计算显示文本与胶囊宽度（逻辑 px）。
 * 空标签返回 null（不渲染胶囊，由死区圆替代）；
 * 超长标签先按最大内宽截断，宽度再钳制在 [CAPSULE_MIN_WIDTH, CAPSULE_MAX_WIDTH]。
 */
export function getCapsuleGeometry(
  label: string,
  maxWidth: number = CAPSULE_MAX_WIDTH,
): { text: string; width: number } | null {
  if (!label) return null;
  const shown = fitText(label, maxWidth - CAPSULE_PADDING_X * 2, CAPSULE_FONT_SIZE);
  const width = Math.max(
    CAPSULE_MIN_WIDTH,
    Math.min(maxWidth, textWidth(shown, CAPSULE_FONT_SIZE) + CAPSULE_PADDING_X * 2),
  );
  return { text: shown, width };
}

export interface WheelItemLayout {
  cx: number;
  cy: number;
  ix: number;
  iy: number;
  rotate: string | undefined;
  labelMaxWidth: number;
  iconSize: number;
}

/** Keeps labels and type icons in separate concentric bands. */
export function getWheelItemLayout(count: number, index: number): WheelItemLayout {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count
  ) {
    throw new RangeError("Invalid wheel item layout arguments");
  }

  const sectorAngle = 360 / count;
  const centerAngle = index * sectorAngle + sectorAngle / 2;
  const mathAngle = (centerAngle - 90) * (Math.PI / 180);

  // Use the inner edge of the text band to ensure adjacent labels have room.
  const safeTextRadius = LABEL_RING_RADIUS - LABEL_FONT_SIZE / 2 - 2;
  const arcMaxWidth = Math.min(
    (2 * Math.PI * safeTextRadius * LABEL_ARC_FILL_RATIO) / count,
    MAX_LABEL_WIDTH,
  );
  const labelX = WINDOW_SIZE / 2 + LABEL_RING_RADIUS * Math.cos(mathAngle);
  const labelY = WINDOW_SIZE / 2 + LABEL_RING_RADIUS * Math.sin(mathAngle);
  const iconX = WINDOW_SIZE / 2 + ICON_RING_RADIUS * Math.cos(mathAngle);
  const iconY = WINDOW_SIZE / 2 + ICON_RING_RADIUS * Math.sin(mathAngle);
  // Keep adjacent icons separated as the number of sectors grows.
  const iconArc = (2 * Math.PI * ICON_RING_RADIUS) / count;
  const iconSize = Math.min(TYPE_ICON_SIZE, Math.max(MIN_TYPE_ICON_SIZE, iconArc * 0.68));
  const iconSafeRadius = iconSize / 2 + TEXT_STROKE_PADDING;
  const tangential = count > TANGENTIAL_LAYOUT_THRESHOLD;
  let rotate: string | undefined;
  let labelMaxWidth = arcMaxWidth;

  if (tangential) {
    let rotation = ((centerAngle % 360) + 360) % 360;
    if (rotation > 90 && rotation < 270) rotation += 180;
    rotate = `rotate(${rotation} ${labelX} ${labelY})`;
  } else {
    // For horizontal labels, reserve the exact part of the icon's safe circle
    // that intersects the label's vertical text band.
    const dx = Math.abs(iconX - labelX);
    const dy = Math.abs(iconY - labelY);
    const verticalGap = Math.max(0, dy - LABEL_FONT_SIZE / 2 - TEXT_STROKE_PADDING);
    if (verticalGap < iconSafeRadius) {
      const iconHalfWidth = Math.sqrt(iconSafeRadius ** 2 - verticalGap ** 2);
      labelMaxWidth = Math.min(
        arcMaxWidth,
        Math.max(0, (dx - iconHalfWidth - TEXT_STROKE_PADDING) * 2),
      );
    }
  }

  return {
    cx: labelX,
    cy: labelY,
    ix: iconX,
    iy: iconY,
    rotate,
    labelMaxWidth,
    iconSize,
  };
}

/**
 * 转盘中心点边界回弹：保证整个窗口（half 为窗口物理半宽高）落在显示器工作区内，
 * 避免光标贴近屏幕边缘时转盘扇区伸出屏幕外无法悬停选中。
 * workArea 为光标所在显示器的工作区（物理像素），缺失时不钳制。
 */
export function clampWheelCenter(
  x: number,
  y: number,
  half: number,
  workArea: { position: { x: number; y: number }; size: { width: number; height: number } } | null,
): { x: number; y: number } {
  if (!workArea) return { x, y };
  const minX = workArea.position.x + half;
  const maxX = workArea.position.x + workArea.size.width - half;
  const minY = workArea.position.y + half;
  const maxY = workArea.position.y + workArea.size.height - half;
  return {
    // 工作区小于窗口（maxX < minX）时范围会反转，此时不做钳制、保留原坐标
    x: maxX >= minX ? Math.min(Math.max(x, minX), maxX) : x,
    y: maxY >= minY ? Math.min(Math.max(y, minY), maxY) : y,
  };
}

/** 根据物理鼠标坐标计算高亮扇区；中心死区与鼠标移动逻辑保持一致。 */
export function getHighlightedSector(
  x: number,
  y: number,
  center: { x: number; y: number },
  scale: number,
  count: number,
): number {
  if (count <= 0) return -1;
  const dx = x - center.x;
  const dy = y - center.y;
  if (Math.hypot(dx, dy) < DEAD_ZONE * scale) return -1;
  const angle = (Math.atan2(dy, dx) * (180 / Math.PI) + 450) % 360;
  return Math.floor(angle / (360 / count)) % count;
}

function QuickInputTool() {
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [visible, setVisible] = useState(false);
  const [items, setItems] = useState<WheelItem[]>([]);
  /** 当前高亮扇区索引，-1 表示无选中 */
  const [highlighted, setHighlighted] = useState(-1);
  /** 窗口中心在屏幕上的物理坐标（用于计算鼠标相对角度） */
  const centerRef = useRef({ x: 0, y: 0 });
  /** 最近一次选中的 item，confirm 时用 ref 取最新值避免闭包陈旧 */
  const highlightedRef = useRef(-1);
  /** items 的 ref 镜像，confirm 时取最新值避免闭包陈旧 */
  const itemsRef = useRef<WheelItem[]>([]);
  /** 转盘是否已就绪（start 完成 setPosition+show），未就绪时忽略 move 事件 */
  const readyRef = useRef(false);
  const generationRef = useRef(0);
  /** 使尚未完成定位的旧 start 请求失效，避免关闭后异步回调重新显示转盘 */
  const startRequestRef = useRef(0);
  /** keyup 可能先于异步 start 定位完成；保留请求并在就绪后结算。 */
  const pendingHoldConfirmRef = useRef<HoldConfirmRequestPayload | null>(null);
  /** 当前显示器缩放比例：move 坐标为物理像素，死区/半径需按此换算成视觉（逻辑）像素 */
  const scaleRef = useRef(1);
  /** 子转盘导航栈：换级压入父级标签与该层条目，返回时弹出。ref 镜像供事件回调读最新值 */
  const [navStack, setNavStack] = useState<NavLevel[]>([]);
  const navStackRef = useRef<NavLevel[]>([]);

  // 同步设置页主题（独立窗口，需手动读取 localStorage）
  useEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    const un = subscribeThemePreferences();
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 透明背景（与其他 overlay 窗口一致）
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  // 加载预设词 + 剪贴板历史，合并为转盘条目
  const refreshItems = async () => {
    const [snippetsJson, history, snippetsEnabled] = await Promise.all([
      invoke<string>("get_quick_input_snippets").catch(() => ""),
      invoke<Array<{ preview: string; text: string; favorite?: boolean }>>(
        "get_quick_input_history",
      ).catch(() => []),
      invoke<boolean>("get_quick_input_snippets_enabled").catch(() => true),
    ]);
    const next: WheelItem[] = [];
    // 预设词（关闭时仅展示剪贴板历史）；带 children 的片段为父级分组条目
    if (snippetsEnabled && snippetsJson) {
      try {
        const parsed = JSON.parse(snippetsJson) as Array<{
          label?: string;
          text?: string;
          children?: Array<{ label?: string; text?: string }>;
        }>;
        for (const s of parsed) {
          const item = snippetToWheelItem(s);
          if (item) next.push(item);
        }
      } catch {
        /* 忽略解析错误 */
      }
    }
    // 剪贴板历史（收藏项已在后端排到最前）
    for (const h of history) {
      if (h.text) {
        next.push({
          label: h.preview || h.text.slice(0, 30),
          text: h.text,
          isHistory: true,
          isFavorite: !!h.favorite,
        });
      }
    }
    syncLevel(next);
  };

  /** 渲染某一级条目：更新状态镜像，并把「父级扇区索引」同步给后端供点击/松开裁决 */
  const syncLevel = (next: WheelItem[]) => {
    setItems(next);
    itemsRef.current = next;
    const parentIndices = next
      .map((it, i) => (it.children?.length ? i : -1))
      .filter((i) => i >= 0);
    void invoke("set_quick_input_wheel_parents", { indices: parentIndices }).catch((err) =>
      console.error("set_quick_input_wheel_parents failed:", err),
    );
  };

  /** 进入子转盘：当前层压栈并渲染子项。目标不是父级时返回 false */
  const expandInto = (index: number): boolean => {
    const item = itemsRef.current[index];
    if (!item?.children?.length) return false;
    navStackRef.current = [
      ...navStackRef.current,
      { label: item.label, items: itemsRef.current },
    ];
    setNavStack(navStackRef.current);
    syncLevel(item.children);
    setHighlightedAndSync(-1);
    return true;
  };

  /** 纯状态出栈：恢复上一层条目（调用前须已获得后端 back 确认） */
  const popLevelLocal = (): boolean => {
    const stack = navStackRef.current;
    if (!stack.length) return false;
    const parent = stack[stack.length - 1];
    navStackRef.current = stack.slice(0, -1);
    setNavStack(navStackRef.current);
    syncLevel(parent.items);
    setHighlightedAndSync(-1);
    return true;
  };

  /** 请求后端返回上一级，成功后出栈；会话已结束时保持原状 */
  const popLevel = async (): Promise<boolean> => {
    const accepted = await invoke<boolean>("back_quick_input_wheel", {
      generation: generationRef.current,
    }).catch(() => false);
    return accepted && popLevelLocal();
  };

  /** 高亮扇区变化时同步给后端，供「按住唤起」模式在松开触发键时读取选中项 */
  const setHighlightedAndSync = (idx: number) => {
    setHighlighted(idx);
    highlightedRef.current = idx;
    invoke("set_quick_input_highlight", { index: idx }).catch((err) =>
      console.error("set_quick_input_highlight failed:", err),
    );
  };

  // 监听后端事件
  useEffect(() => {
    const invalidatePendingStart = () => {
      startRequestRef.current += 1;
      readyRef.current = false;
      pendingHoldConfirmRef.current = null;
    };

    const syncHighlightedAt = (x: number, y: number) => {
      const idx = getHighlightedSector(
        x,
        y,
        centerRef.current,
        scaleRef.current,
        itemsRef.current.length,
      );
      if (highlightedRef.current !== idx) setHighlightedAndSync(idx);
      return idx;
    };

    const confirmPendingHold = () => {
      const pending = pendingHoldConfirmRef.current;
      if (!pending || !readyRef.current) return;
      pendingHoldConfirmRef.current = null;
      const selectedIndex = syncHighlightedAt(pending.x, pending.y);
      if (selectedIndex < 0 && navStackRef.current.length) {
        // 按住模式在死区松开：子级视为「返回上一级」，根级维持原取消语义
        void invoke<boolean>("back_quick_input_wheel", { generation: pending.generation })
          .then((accepted) => {
            if (accepted) popLevelLocal();
          })
          .catch((err) => console.error("quick input back failed:", err));
        return;
      }
      const target = selectedIndex >= 0 ? itemsRef.current[selectedIndex] : undefined;
      if (target?.children?.length) {
        // 按住模式在父级扇区松开：后端保持会话并返回 true，前端换级进入子转盘
        void invoke<boolean>("confirm_quick_input_hold", {
          generation: pending.generation,
          selectedIndex,
        })
          .then((expanded) => {
            if (expanded) expandInto(selectedIndex);
          })
          .catch((err) => {
            console.error("quick input hold confirmation failed:", err);
            void invoke("cancel_quick_input_wheel", { generation: pending.generation });
          });
        return;
      }
      invoke("confirm_quick_input_hold", {
        generation: pending.generation,
        selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
      }).catch((err) => {
        console.error("quick input hold confirmation failed:", err);
        void invoke("cancel_quick_input_wheel", { generation: pending.generation });
      });
    };

    const handleStart = async ({ x, y, generation = 0 }: CoordPayload) => {
      if (generation > 0 && generation <= generationRef.current) return;
      if (generation > 0) generationRef.current = generation;
      // 新会话从根级开始：清空上一会话残留的子转盘导航栈
      navStackRef.current = [];
      setNavStack([]);
      const requestId = ++startRequestRef.current;
      // 窗口中心对准鼠标位置；贴近屏幕边缘时对光标所在显示器的工作区做边界回弹
      const monitor = await monitorFromPoint(x, y).catch(() => null);
      if (requestId !== startRequestRef.current) return;
      // 用光标所在显示器的缩放比例计算物理窗口半尺寸（跨 DPI 时比 win.scaleFactor 更准确），失败则回退
      const scale = monitor?.scaleFactor ?? (await win.scaleFactor().catch(() => 1));
      if (requestId !== startRequestRef.current) return;
      scaleRef.current = scale;
      const half = (WINDOW_SIZE * scale) / 2;
      const center = clampWheelCenter(x, y, half, monitor?.workArea ?? null);
      const left = Math.round(center.x - half);
      const top = Math.round(center.y - half);
      // 以取整后的实际窗口中心作为角度计算基准（与原实现约定一致）
      centerRef.current = { x: left + half, y: top + half };
      setHighlightedAndSync(-1);
      readyRef.current = false;
      // 先显示转盘再异步刷新条目，避免 refreshItems 往返延迟导致转盘迟迟不出现
      setVisible(true);
      // 后端已完成定位和显示；这里仅按显示器 DPI 修正精确位置。
      try {
        await win.setPosition(new PhysicalPosition(left, top));
      } catch (err) {
        if (requestId === startRequestRef.current && generation > 0) {
          await invoke("cancel_quick_input_wheel", {
            generation,
          }).catch((cancelErr) => console.error("quick input cancel failed:", cancelErr));
        }
        if (requestId === startRequestRef.current) {
          readyRef.current = false;
          setVisible(false);
          await win.hide().catch(() => {});
          console.error("quick input overlay positioning failed:", err);
        }
        return;
      }
      if (requestId !== startRequestRef.current) return;
      // 定位期间可能已经收到关闭事件；再次确认后端仍是本次会话，避免旧查询复活转盘。
      const state = await invoke<QuickInputState>("get_quick_input_state").catch(() => null);
      const sessionChanged = state !== null && generation > 0 && state.generation !== generation;
      if (requestId !== startRequestRef.current) return;
      if (sessionChanged && state.active) {
        // 旧 start 查询期间若已经开启了新会话，接管最新状态，补偿新 start 事件丢失。
        void handleStart(state);
        return;
      }
      if (state !== null && !state.active) {
        if (requestId === startRequestRef.current) {
          readyRef.current = false;
          pendingHoldConfirmRef.current = null;
          setVisible(false);
          await win.hide().catch(() => {});
        }
        return;
      }
      if (
        state !== null &&
        pendingHoldConfirmRef.current &&
        pendingHoldConfirmRef.current.generation !== state.generation
      ) {
        pendingHoldConfirmRef.current = null;
      }
      if (
        state?.holdConfirmPending &&
        state.holdConfirmX !== undefined &&
        state.holdConfirmY !== undefined
      ) {
        pendingHoldConfirmRef.current = {
          x: state.holdConfirmX,
          y: state.holdConfirmY,
          generation: state.generation,
        };
      }
      // 先完成条目加载，再允许 move/confirm 参与结算，确保索引对应已渲染扇区。
      await refreshItems();
      if (requestId !== startRequestRef.current) return;
      // 就绪标志置 true：此后 move 事件才参与角度计算
      readyRef.current = true;
      confirmPendingHold();
    };

    const unlistenStart = listen<CoordPayload>("quick-input-start", (event) =>
      handleStart(event.payload),
    );

    const unlistenMove = listen<CoordPayload>("quick-input-mouse-move", (event) => {
      // 转盘尚未就绪（start 还在定位中）时忽略，避免用陈旧 centerRef 算错角度
      if (!readyRef.current) return;
      syncHighlightedAt(event.payload.x, event.payload.y);
    });

    const unlistenHoldConfirm = listen<HoldConfirmRequestPayload>(
      "quick-input-confirm-request",
      (event) => {
        if (
          event.payload.generation !== undefined &&
          generationRef.current !== 0 &&
          event.payload.generation !== generationRef.current
        ) {
          return;
        }
        pendingHoldConfirmRef.current = event.payload;
        confirmPendingHold();
      },
    );

    // quick-input-confirm：后端「结束转盘」时触发。selectedIndex 携带本次选中的扇区
    // （null=未选中/取消）。此事件用于触发键再次点击关闭、以及取消输入的场景。
    const unlistenConfirm = listen<ConfirmPayload>("quick-input-confirm", async (event) => {
      if (
        event.payload.generation !== undefined &&
        event.payload.generation !== generationRef.current
      ) {
        return;
      }
      invalidatePendingStart();
      const idx = event.payload.selectedIndex ?? -1;
      setVisible(false);
      await win.hide();
      const currentItems = itemsRef.current;
      const item = idx >= 0 ? currentItems[idx] : undefined;
      // 同点击路径：仅对有文本的叶子条目执行输入，防父级同步滞后时空文本粘贴
      if (item?.text) {
        await invoke("quick_input_paste", { text: item.text }).catch((err) =>
          console.error("quick_input_paste failed:", err),
        );
      }
    });

    // 鼠标点击选中：由 mouse hook 在转盘激活时命中后触发。
    // 三种分支：死区点击（子级=返回上级 / 根级=取消）、父级点击（换级展开）、
    // 叶子点击（结束后读取当前高亮项执行输入并隐藏窗口）。
    const unlistenClick = listen<{
      generation?: number;
      deadZone?: boolean;
      expand?: boolean;
    }>("quick-input-click", async (event) => {
      if (
        event.payload.generation !== undefined &&
        event.payload.generation !== generationRef.current
      ) {
        return;
      }
      if (event.payload.deadZone) {
        if (navStackRef.current.length) {
          await popLevel();
        } else {
          await invoke("cancel_quick_input_wheel", {
            generation: event.payload.generation ?? generationRef.current,
          }).catch((err) => console.error("quick input cancel failed:", err));
        }
        return;
      }
      if (event.payload.expand) {
        expandInto(highlightedRef.current);
        return;
      }
      invalidatePendingStart();
      const idx = highlightedRef.current;
      setVisible(false);
      await win.hide();
      const currentItems = itemsRef.current;
      const item = idx >= 0 ? currentItems[idx] : undefined;
      // 只对有文本的叶子条目执行输入：分组条目 text 为空（且父级索引同步存在
      // IPC 滞后窗口，此处可能把分组当叶子），空文本粘贴会走完整管线且抢占
      // PASTE_INFLIGHT 吞掉后续真实粘贴。
      if (item?.text) {
        await invoke("quick_input_paste", { text: item.text }).catch((err) =>
          console.error("quick_input_paste failed:", err),
        );
      }
    });

    // Esc（keyboard hook 转发）：子级返回上一级，根级关闭转盘。
    // overlay 无焦点收不到 DOM keydown，必须经全局钩子转发。
    const unlistenEsc = listen<{ generation?: number }>("quick-input-esc", async (event) => {
      const gen = event.payload.generation;
      if (gen !== undefined && gen !== generationRef.current) return;
      if (navStackRef.current.length) {
        await popLevel();
      } else {
        await invoke("cancel_quick_input_wheel", {
          generation: gen ?? generationRef.current,
        }).catch((err) => console.error("quick input cancel failed:", err));
      }
    });

    // 监听器注册后主动查询一次，补偿 start 事件在 React/WebView 初始化期间丢失的情况。
    void invoke<QuickInputState>("get_quick_input_state")
      .then((state) => {
        if (state.active) {
          if (
            state.holdConfirmPending &&
            state.holdConfirmX !== undefined &&
            state.holdConfirmY !== undefined
          ) {
            pendingHoldConfirmRef.current = {
              x: state.holdConfirmX,
              y: state.holdConfirmY,
              generation: state.generation,
            };
          }
          void handleStart(state);
        }
      })
      .catch(() => {});

    return () => {
      invalidatePendingStart();
      unlistenStart.then((fn) => fn());
      unlistenMove.then((fn) => fn());
      unlistenHoldConfirm.then((fn) => fn());
      unlistenConfirm.then((fn) => fn());
      unlistenClick.then((fn) => fn());
      unlistenEsc.then((fn) => fn());
    };
  }, [win]);

  // 转盘扇区渲染数据
  const sectors = useMemo(() => {
    const count = items.length;
    if (count === 0) return [];
    const sectorAngle = 360 / count;
    return items.map((item, i) => {
      const layout = getWheelItemLayout(count, i);
      const fontSize = LABEL_FONT_SIZE;
      const label = fitText(item.label, layout.labelMaxWidth, fontSize);
      // 扇区起止角度（用于 SVG path）
      const startAngle = (i * sectorAngle - 90) * (Math.PI / 180);
      const endAngle = ((i + 1) * sectorAngle - 90) * (Math.PI / 180);
      const r = WHEEL_RADIUS;
      const x1 = WINDOW_SIZE / 2 + r * Math.cos(startAngle);
      const y1 = WINDOW_SIZE / 2 + r * Math.sin(startAngle);
      const x2 = WINDOW_SIZE / 2 + r * Math.cos(endAngle);
      const y2 = WINDOW_SIZE / 2 + r * Math.sin(endAngle);
      const largeArc = sectorAngle > 180 ? 1 : 0;
      const path = `M ${WINDOW_SIZE / 2} ${WINDOW_SIZE / 2} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      return {
        item,
        path,
        cx: layout.cx,
        cy: layout.cy,
        ix: layout.ix,
        iy: layout.iy,
        anchor: "middle" as const,
        rotate: layout.rotate,
        fontSize,
        iconSize: layout.iconSize,
        label,
        isActive: i === highlighted,
      };
    });
  }, [items, highlighted]);

  // 高亮条目的完整标签：用于中心胶囊展示，补偿扇区标签因拥挤而截断的信息
  const activeLabel =
    highlighted >= 0 && highlighted < items.length ? items[highlighted].label : "";
  const centerHint = useMemo(() => getCapsuleGeometry(activeLabel), [activeLabel]);

  // 子级面包屑：无高亮且处于子级时，中心胶囊显示「‹ 父级标签」，死区点击即返回。
  // 面包屑宽度上限压到 140，减少与左右两侧扇区标签的视觉挤压。
  const breadcrumb = navStack.length ? `‹ ${navStack[navStack.length - 1].label}` : null;
  const breadcrumbHint = useMemo(
    () => (breadcrumb ? getCapsuleGeometry(breadcrumb, 140) : null),
    [breadcrumb],
  );

  // 分组分隔线：预设词全部在前、历史项在后，交界处 = 第一个历史项的起始扇区边界。
  // 仅当两类条目同时存在时绘制；全预设或全历史时无需分隔。
  const divider = useMemo(() => {
    const count = items.length;
    if (count === 0) return null;
    const historyStartIdx = items.findIndex((it) => it.isHistory);
    if (historyStartIdx <= 0) return null;
    const sectorAngle = 360 / count;
    const angle = (historyStartIdx * sectorAngle - 90) * (Math.PI / 180);
    return {
      x1: WINDOW_SIZE / 2 + DEAD_ZONE * Math.cos(angle),
      y1: WINDOW_SIZE / 2 + DEAD_ZONE * Math.sin(angle),
      x2: WINDOW_SIZE / 2 + WHEEL_RADIUS * Math.cos(angle),
      y2: WINDOW_SIZE / 2 + WHEEL_RADIUS * Math.sin(angle),
    };
  }, [items]);

  if (!visible) return null;

  return (
    <div className="quick-input-root">
      <svg
        width={WINDOW_SIZE}
        height={WINDOW_SIZE}
        viewBox={`0 0 ${WINDOW_SIZE} ${WINDOW_SIZE}`}
        className="quick-input-wheel"
      >
        {/* 装饰外圈：强化转盘边界，不参与扇区命中 */}
        <circle
          cx={WINDOW_SIZE / 2}
          cy={WINDOW_SIZE / 2}
          r={WHEEL_RADIUS + 8}
          className="quick-input-outer-ring"
          pointerEvents="none"
        />
        <circle
          cx={WINDOW_SIZE / 2}
          cy={WINDOW_SIZE / 2}
          r={WHEEL_RADIUS + 4}
          className="quick-input-outer-highlight"
          pointerEvents="none"
        />
        {/* 底盘：统一转盘的基底色，让扇区在桌面上有清晰的轮廓平台 */}
        <circle
          cx={WINDOW_SIZE / 2}
          cy={WINDOW_SIZE / 2}
          r={WHEEL_RADIUS + 2}
          className="quick-input-base"
        />
        {/* 扇区 */}
        {sectors.map((s, i) => (
          <g key={i}>
            <path
              d={s.path}
              className={
                s.isActive ? "quick-input-sector quick-input-sector-active" : "quick-input-sector"
              }
              data-history={s.item.isHistory ? "true" : "false"}
            />
            {/* 高亮扇区标签由中心胶囊完整展示，此处隐藏避免与胶囊文字重叠 */}
            {!(s.isActive && centerHint) && (
              <text
                x={s.cx}
                y={s.cy}
                transform={s.rotate}
                className="quick-input-label"
                textAnchor={s.anchor}
                dominantBaseline="middle"
                style={{ fontSize: s.fontSize }}
              >
                {s.label}
              </text>
            )}
            {/* 类型标记：预设词=书签、历史=时钟、收藏历史=星标；与底色差异共同区分条目类型 */}
            <g
              transform={`translate(${s.ix - s.iconSize / 2} ${s.iy - s.iconSize / 2})`}
              className="quick-input-type-icon"
              data-history={s.item.isHistory ? "true" : "false"}
              data-favorite={s.item.isFavorite ? "true" : "false"}
              pointerEvents="none"
            >
              {s.item.isFavorite ? (
                <Icon name="Star" size={s.iconSize} />
              ) : s.item.isHistory ? (
                <Icon name="History" size={s.iconSize} />
              ) : (
                <Icon name="Bookmark" size={s.iconSize} />
              )}
            </g>
          </g>
        ))}
        {/* 分组分隔线：预设词区与剪贴板历史区的分界 */}
        {divider && <line {...divider} className="quick-input-divider" />}
        {/* 无高亮且无面包屑（根级）时保留中心死区圆作为稳定锚点；有高亮时由胶囊替代 */}
        {!centerHint && !breadcrumbHint && (
          <>
            <circle
              cx={WINDOW_SIZE / 2}
              cy={WINDOW_SIZE / 2}
              r={DEAD_ZONE + 4}
              className="quick-input-center-ring"
              pointerEvents="none"
            />
            <circle
              cx={WINDOW_SIZE / 2}
              cy={WINDOW_SIZE / 2}
              r={DEAD_ZONE}
              className="quick-input-center"
            />
          </>
        )}
        {/* 中心胶囊：完整展示高亮标签，宽度随文本自适应（上限内截断） */}
        {centerHint && (
          <g>
            <rect
              x={WINDOW_SIZE / 2 - centerHint.width / 2}
              y={WINDOW_SIZE / 2 - CAPSULE_HEIGHT / 2}
              width={centerHint.width}
              height={CAPSULE_HEIGHT}
              rx={CAPSULE_RADIUS}
              className="quick-input-capsule"
            />
            <text
              x={WINDOW_SIZE / 2}
              y={WINDOW_SIZE / 2}
              className="quick-input-capsule-label"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fontSize: CAPSULE_FONT_SIZE }}
            >
              {centerHint.text}
            </text>
          </g>
        )}
        {/* 子级面包屑胶囊：弱化描边 + 弱化文字，与「当前选中」胶囊区分 */}
        {!centerHint && breadcrumbHint && (
          <g>
            <rect
              x={WINDOW_SIZE / 2 - breadcrumbHint.width / 2}
              y={WINDOW_SIZE / 2 - CAPSULE_HEIGHT / 2}
              width={breadcrumbHint.width}
              height={CAPSULE_HEIGHT}
              rx={CAPSULE_RADIUS}
              className="quick-input-capsule quick-input-capsule-breadcrumb"
            />
            <text
              x={WINDOW_SIZE / 2}
              y={WINDOW_SIZE / 2}
              className="quick-input-capsule-label quick-input-capsule-breadcrumb-label"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fontSize: CAPSULE_FONT_SIZE }}
            >
              {breadcrumbHint.text}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

export default QuickInputTool;
