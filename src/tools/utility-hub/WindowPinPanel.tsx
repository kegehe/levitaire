import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Icon from "../../components/Icon";

/** 一个由本工具置顶的窗口 */
interface PinnedWindow {
  hwnd: number;
  title: string;
}

/** 后端推送的完整状态 */
interface PinUpdate {
  windows: PinnedWindow[];
  message: string | null;
  /** 这条 message 是否代表一次失败 —— 配色要跟着它走。 */
  error: boolean;
  picking: boolean;
}

/** 一句操作反馈。成功与失败都走它 —— 两者的停留规则一致，只有配色不同。
 *
 * 之前只有「成功」有倒计时、失败常驻，结果是：面板关了又开（组件不卸载）时，
 * 上次那条早就过期的错误还挂在上面，用户以为刚才那一下又失败了。 */
interface Notice {
  id: number;
  text: string;
  kind: "info" | "error";
}

/** 提示停留时长：够看清一次操作结果，又不至于一直占着面板。 */
const NOTICE_TIMEOUT_MS = 2600;

/** 只接受数组：命令返回异常值（undefined / null）时面板要照常渲染，而不是崩在
 * `list.length` 上 —— 这个面板常驻在悬浮窗里，白屏等于整个通用工具都用不了。 */
function toWindows(value: unknown): PinnedWindow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PinnedWindow =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as PinnedWindow).hwnd === "number" &&
      typeof (item as PinnedWindow).title === "string",
  );
}

function WindowPinPanel() {
  const [windows, setWindows] = useState<PinnedWindow[]>([]);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 挂载时那次「读真值」与后端推送会交错：推送代表的是更新的状态，一旦收到过，
  // 就不能再被早先发出、更晚返回的读取结果覆盖回旧值。
  const pushedRef = useRef(false);
  // 自增序号而非 `Date.now()`：同一毫秒内的两条提示会拿到相同的 id，
  // 依赖项没变 effect 就不会重跑，第二次的倒计时会沿用第一次的剩余时间。
  const noticeSeq = useRef(0);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const report = useCallback((text: string, kind: Notice["kind"] = "info") => {
    noticeSeq.current += 1;
    setNotice({ id: noticeSeq.current, text, kind });
  }, []);

  useEffect(() => {
    // 挂载时先读一次真值：面板可能是在点选/置顶之后才被切过来的。
    void invoke<PinnedWindow[]>("get_pinned_windows")
      .then((list) => {
        if (!pushedRef.current) setWindows(toWindows(list));
      })
      .catch(() => {});

    // 之后的清单与模式状态一律以后端推送为准 —— 点选成功、Esc 退出这些路径
    // 都不经过前端，本地猜出来的状态会跟真值漂移。
    const unlisten = listen<PinUpdate>("window-pin-updated", (event) => {
      pushedRef.current = true;
      setWindows(toWindows(event.payload?.windows));
      setPicking(event.payload?.picking === true);
      // 失败提示与成功提示走同一条通道（后端带 error 标记），配色由此决定 ——
      // 「无法置顶：X（权限不足）」绝不能看着像「已置顶：X」。
      if (event.payload?.message) {
        report(event.payload.message, event.payload?.error ? "error" : "info");
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [report]);

  const togglePick = useCallback(async () => {
    try {
      if (picking) {
        await invoke("stop_window_pin_pick");
        setPicking(false);
      } else {
        await invoke("start_window_pin_pick");
        setPicking(true);
      }
    } catch (cause) {
      // 启动失败（拿不到准星光标等）时后端没有进模式，本地状态不能停在「进行中」。
      setPicking(false);
      report(typeof cause === "string" ? cause : "无法进入点选模式", "error");
    }
  }, [picking, report]);

  const unpin = async (hwnd: number) => {
    try {
      await invoke("unpin_window", { hwnd });
    } catch (cause) {
      report(typeof cause === "string" ? cause : "无法取消置顶", "error");
    }
  };

  const unpinAll = async () => {
    try {
      await invoke("unpin_all_windows");
    } catch (cause) {
      report(typeof cause === "string" ? cause : "无法取消置顶", "error");
    }
  };

  return (
    <section className="utility-pin" aria-label="窗口置顶">
      <button
        className={`utility-pin-pick ${picking ? "is-active" : ""}`}
        type="button"
        aria-pressed={picking}
        onClick={() => void togglePick()}
      >
        <Icon name={picking ? "X" : "AppWindow"} size={14} />
        {picking ? "退出点选" : "点选目标窗口"}
      </button>

      <p className="utility-pin-hint">
        {picking ? "点击任意窗口切换置顶，Esc 退出" : "置顶后窗口会一直浮在其他程序之上"}
      </p>

      {windows.length > 0 ? (
        <>
          <ul className="utility-pin-list">
            {windows.map((item) => (
              <li key={item.hwnd}>
                <span className="utility-pin-title" title={item.title}>
                  {item.title}
                </span>
                <button
                  type="button"
                  aria-label={`取消置顶 ${item.title}`}
                  title="取消置顶"
                  onClick={() => void unpin(item.hwnd)}
                >
                  <Icon name="X" size={12} />
                </button>
              </li>
            ))}
          </ul>
          {windows.length > 1 && (
            <button className="utility-pin-clear" type="button" onClick={() => void unpinAll()}>
              全部取消（{windows.length}）
            </button>
          )}
        </>
      ) : (
        <p className="utility-pin-empty">尚未置顶任何窗口</p>
      )}

      {notice && (
        <p
          className={`utility-hub-message${notice.kind === "error" ? " is-error" : ""}`}
          role="status"
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}

export default WindowPinPanel;
