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
  /** 选中后输入的完整文本 */
  text: string;
  /** 是否为剪贴板历史项（历史项用不同颜色区分） */
  isHistory: boolean;
}

/** 后端 quick-input-start / quick-input-mouse-move 事件 payload */
interface CoordPayload {
  x: number;
  y: number;
}

/** 后端 quick-input-confirm 事件 payload */
interface ConfirmPayload {
  selectedIndex: number | null;
}

/** 窗口逻辑尺寸（CSS px，与后端 ensure_quick_input_window 的 inner_size 一致；物理尺寸 = 值 × scale） */
const WINDOW_SIZE = 320;
/** 转盘外半径（逻辑像素，按 scale 1 设计；高 DPI 下窗口/图形随系统缩放自动放大） */
const WHEEL_RADIUS = 130;
/** 中心死区半径（逻辑像素）：鼠标在此范围内不选中任何扇区。move 坐标为物理像素，命中判断需 ×scale 换算 */
const DEAD_ZONE = 18;
/** 扇区类型标记图标尺寸（逻辑像素） */
const TYPE_ICON_SIZE = 12;
/** 类型标记图标所在半径（label 外侧、贴近外缘，图标与文本沿径向排列） */
const TYPE_ICON_RADIUS = WHEEL_RADIUS * 0.84;
/** 水平/径向布局切换阈值：扇区数大于该值时，标签沿半径排布避免切向重叠 */
const RADIAL_THRESHOLD = 8;
/** 径向布局：标签锚点（文本起点）半径。取 45px 大于中心圆最大半径 42px，高亮放大时不被遮挡 */
const RADIAL_LABEL_START_R = 45;
/** 径向布局：标签文本终点半径，停在类型图标内侧 */
const RADIAL_LABEL_END_R = WHEEL_RADIUS * 0.88;
/** 径向布局：类型标记图标中心半径（比水平模式更靠外缘，给文本让位） */
const RADIAL_ICON_R = WHEEL_RADIUS * 0.95;
/** 径向布局：类型标记图标尺寸（扇区拥挤时略缩小） */
const RADIAL_ICON_SIZE = 10;
/** 中心完整标签：最大字号 */
const CENTER_FONT_MAX = 13;
/** 中心完整标签：最小字号 */
const CENTER_FONT_MIN = 8;
/** 中心完整标签：高亮时中心圆放大显示完整文本的最大半径（小于径向文本起点 45，不遮挡扇区标签） */
const CENTER_MAX_R = 42;
/** 水平布局：标签最大宽度（约 10 个 12.5px 全角字符，与原实现的固定 10 字符截断一致）。
 *  防止 count 小时水平标签过长侵入中心圆/类型图标区域 */
const HORIZONTAL_MAX_LABEL_W = 125;

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
  /** 当前显示器缩放比例：move 坐标为物理像素，死区/半径需按此换算成视觉（逻辑）像素 */
  const scaleRef = useRef(1);

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
    const [snippetsJson, history] = await Promise.all([
      invoke<string>("get_quick_input_snippets").catch(() => ""),
      invoke<Array<{ preview: string; text: string }>>("get_quick_input_history").catch(() => []),
    ]);
    const next: WheelItem[] = [];
    // 预设词
    if (snippetsJson) {
      try {
        const parsed = JSON.parse(snippetsJson) as Array<{ label: string; text: string }>;
        for (const s of parsed) {
          if (s.text) {
            next.push({ label: s.label || s.text.slice(0, 20), text: s.text, isHistory: false });
          }
        }
      } catch {
        /* 忽略解析错误 */
      }
    }
    // 剪贴板历史（最新在前）
    for (const h of history) {
      if (h.text) {
        next.push({ label: h.preview || h.text.slice(0, 30), text: h.text, isHistory: true });
      }
    }
    setItems(next);
    itemsRef.current = next;
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
    const unlistenStart = listen<CoordPayload>("quick-input-start", async (event) => {
      const { x, y } = event.payload;
      // 窗口中心对准鼠标位置；贴近屏幕边缘时对光标所在显示器的工作区做边界回弹
      const monitor = await monitorFromPoint(x, y).catch(() => null);
      // 用光标所在显示器的缩放比例计算物理窗口半尺寸（跨 DPI 时比 win.scaleFactor 更准确），失败则回退
      const scale = monitor?.scaleFactor ?? (await win.scaleFactor().catch(() => 1));
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
      await win.setPosition(new PhysicalPosition(left, top));
      await win.show();
      // 就绪标志置 true：此后 move 事件才参与角度计算
      readyRef.current = true;
      // 异步加载条目（预设词 + 剪贴板历史）
      void refreshItems();
    });

    const unlistenMove = listen<CoordPayload>("quick-input-mouse-move", (event) => {
      // 转盘尚未就绪（start 还在 setPosition/show 中）时忽略，避免用陈旧 centerRef 算错角度
      if (!readyRef.current) return;
      const { x, y } = event.payload;
      const center = centerRef.current;
      const dx = x - center.x;
      const dy = y - center.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // 中心死区：不选中。dist 为物理像素，视觉中心圆半径按 DEAD_ZONE × scale 放大，
      // 高 DPI 下若不乘 scale 会因阈值偏小而误选中扇区
      if (dist < DEAD_ZONE * scaleRef.current) {
        if (highlightedRef.current !== -1) {
          setHighlightedAndSync(-1);
        }
        return;
      }
      // 计算角度：0° 指向正上方（-y），顺时针递增
      let angle = Math.atan2(dy, dx) * (180 / Math.PI); // -180..180，0=正东
      angle = (angle + 90 + 360) % 360; // 转为 0=正上方，顺时针
      const count = itemsRef.current.length;
      if (count === 0) return;
      const sector = 360 / count;
      const idx = Math.floor(angle / sector) % count;
      if (highlightedRef.current !== idx) {
        setHighlightedAndSync(idx);
      }
    });

    // quick-input-confirm：后端「结束转盘」时触发。selectedIndex 携带本次选中的扇区
    // （null=未选中/取消）。此事件用于触发键再次点击关闭、以及取消输入的场景。
    const unlistenConfirm = listen<ConfirmPayload>("quick-input-confirm", async (event) => {
      const idx = event.payload.selectedIndex ?? -1;
      readyRef.current = false;
      setVisible(false);
      await win.hide();
      const currentItems = itemsRef.current;
      // 仅当后端明确给出有效选中索引时才输入；否则视为取消，不做任何粘贴。
      if (idx >= 0 && idx < currentItems.length) {
        const item = currentItems[idx];
        await invoke("quick_input_paste", { text: item.text }).catch((err) =>
          console.error("quick_input_paste failed:", err),
        );
      }
    });

    // 鼠标点击选中：由 mouse hook 在转盘激活时命中后触发。
    // 点击发生后后端已退出转盘模式，此处读取当前高亮项执行输入并隐藏窗口。
    const unlistenClick = listen("quick-input-click", async () => {
      const idx = highlightedRef.current;
      readyRef.current = false;
      setVisible(false);
      await win.hide();
      const currentItems = itemsRef.current;
      if (idx >= 0 && idx < currentItems.length) {
        const item = currentItems[idx];
        await invoke("quick_input_paste", { text: item.text }).catch((err) =>
          console.error("quick_input_paste failed:", err),
        );
      }
    });

    return () => {
      unlistenStart.then((fn) => fn());
      unlistenMove.then((fn) => fn());
      unlistenConfirm.then((fn) => fn());
      unlistenClick.then((fn) => fn());
    };
  }, [win]);

  // 转盘扇区渲染数据
  const sectors = useMemo(() => {
    const count = items.length;
    if (count === 0) return [];
    const sectorAngle = 360 / count;
    // 扇区多时改用径向布局：文本沿半径排布、字头恒朝上，避免标签在切向拥挤时相互重叠
    const radial = count > RADIAL_THRESHOLD;
    // 径向布局字号：按扇区在文本起点（最小）半径处的切向宽度估算并留 1.05 倍安全余量，
    // 保证文本内侧（半径最小处弧长最短）也不会与相邻扇区切向重叠
    const radialFontSize = Math.min(
      12.5,
      Math.max(8, (2 * Math.PI * RADIAL_LABEL_START_R) / count / 1.05),
    );
    // 水平布局：标签宽度取「扇区弧长」「最大标签宽」的较小值，扇区越密截断越短，
    // 同时避免 count 小时长标签侵入中心圆与类型图标区域
    const horizontalLabelR = WHEEL_RADIUS * 0.68;
    const horizontalMaxWidth = Math.min(
      ((2 * Math.PI * horizontalLabelR) / count) * 0.92,
      HORIZONTAL_MAX_LABEL_W,
    );
    return items.map((item, i) => {
      // 扇区中心角度（0=正上方，顺时针）
      const centerAngle = i * sectorAngle + sectorAngle / 2;
      // 转为标准数学角度（0=正东，逆时针）用于定位标签
      const mathAngle = (centerAngle - 90) * (Math.PI / 180);
      // 标签位置与方向
      let cx: number;
      let cy: number;
      let anchor: "start" | "middle" | "end";
      let rotate: string | undefined;
      let label: string;
      let fontSize: number;
      if (radial) {
        // 文本基线沿半径方向：rot 为屏幕角（0=正东，顺时针），等于扇区径向向外的方向。
        // 扇区在屏幕左半区（rot∈(90,270)）时文本会倒置，翻转 180° 后基线指向圆心、字头恒朝上，
        // 此时锚点取外缘、textAnchor 保持 start，文本从外缘向圆心延伸；右半区不翻转、从内缘向外延伸。
        let rot = ((centerAngle - 90) % 360 + 360) % 360;
        const flip = rot > 90 && rot < 270;
        if (flip) rot += 180;
        const startR = flip ? RADIAL_LABEL_END_R : RADIAL_LABEL_START_R;
        cx = WINDOW_SIZE / 2 + startR * Math.cos(mathAngle);
        cy = WINDOW_SIZE / 2 + startR * Math.sin(mathAngle);
        anchor = "start";
        rotate = `rotate(${rot} ${cx} ${cy})`;
        fontSize = radialFontSize;
        label = fitText(item.label, RADIAL_LABEL_END_R - RADIAL_LABEL_START_R, fontSize);
      } else {
        cx = WINDOW_SIZE / 2 + horizontalLabelR * Math.cos(mathAngle);
        cy = WINDOW_SIZE / 2 + horizontalLabelR * Math.sin(mathAngle);
        anchor = "middle";
        rotate = undefined;
        fontSize = 12.5;
        label = fitText(item.label, horizontalMaxWidth, fontSize);
      }
      // 类型标记图标中心（label 外侧，与文本沿同一角度径向排列）
      const iconR = radial ? RADIAL_ICON_R : TYPE_ICON_RADIUS;
      const iconSize = radial ? RADIAL_ICON_SIZE : TYPE_ICON_SIZE;
      const ix = WINDOW_SIZE / 2 + iconR * Math.cos(mathAngle);
      const iy = WINDOW_SIZE / 2 + iconR * Math.sin(mathAngle);
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
        cx,
        cy,
        ix,
        iy,
        anchor,
        rotate,
        fontSize,
        iconSize,
        label,
        isActive: i === highlighted,
      };
    });
  }, [items, highlighted]);

  // 高亮条目的完整标签：用于中心放大圆内展示，补偿扇区标签因拥挤而截断的信息
  const activeLabel =
    highlighted >= 0 && highlighted < items.length ? items[highlighted].label : "";
  const centerHint = useMemo(() => {
    if (!activeLabel) return null;
    // 文本宽度尽量适配中心圆，字号从大到小收缩
    const maxInnerWidth = 2 * (CENTER_MAX_R - 6);
    let fontSize = CENTER_FONT_MAX;
    let width = textWidth(activeLabel, fontSize);
    while (width > maxInnerWidth && fontSize > CENTER_FONT_MIN) {
      fontSize -= 1;
      width = textWidth(activeLabel, fontSize);
    }
    const shown = fitText(activeLabel, maxInnerWidth, fontSize);
    const shownWidth = textWidth(shown, fontSize);
    const radius = Math.max(DEAD_ZONE, Math.min(CENTER_MAX_R, shownWidth / 2 + 7));
    return { text: shown, fontSize, radius };
  }, [activeLabel]);

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
            {/* 类型标记：预设词=书签、历史=时钟，与底色差异共同区分两类条目 */}
            <g
              transform={`translate(${s.ix - s.iconSize / 2} ${s.iy - s.iconSize / 2})`}
              className="quick-input-type-icon"
              data-history={s.item.isHistory ? "true" : "false"}
              pointerEvents="none"
            >
              {s.item.isHistory ? (
                <Icon name="History" size={s.iconSize} />
              ) : (
                <Icon name="Bookmark" size={s.iconSize} />
              )}
            </g>
          </g>
        ))}
        {/* 分组分隔线：预设词区与剪贴板历史区的分界 */}
        {divider && <line {...divider} className="quick-input-divider" />}
        {/* 中心死区圆：高亮时放大并在其中展示完整标签，补偿扇区标签截断的信息 */}
        <circle
          cx={WINDOW_SIZE / 2}
          cy={WINDOW_SIZE / 2}
          r={centerHint ? centerHint.radius : DEAD_ZONE}
          className="quick-input-center"
        />
        {centerHint && (
          <text
            x={WINDOW_SIZE / 2}
            y={WINDOW_SIZE / 2}
            className="quick-input-center-label"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontSize: centerHint.fontSize }}
          >
            {centerHint.text}
          </text>
        )}
      </svg>
    </div>
  );
}

export default QuickInputTool;
