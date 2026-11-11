import { useEffect, useRef, type ReactNode } from "react";
import Icon from "./Icon";
import "./ConfirmDialog.css";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 说明文案，支持带加粗等富文本（如「其中 <b>2 个副本</b>将被删除」）。 */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破坏性操作时确认按钮呈危险红，默认焦点落在「取消」上（Enter 不会误执行）。 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 项目统一的确认弹窗（替代浏览器原生 confirm / alert / prompt——那些在 WebView2 里
 * 是无样式系统弹窗，主题与明暗模式都不受控）。
 *
 * 交互约定：
 * - 打开时焦点在「取消」上（danger 尤其如此），Enter / 空格激活的是**焦点所在按钮**
 *   （原生行为）——连按 Enter 只会取消，不会误执行破坏性操作；
 * - Esc 取消（捕获阶段处理，抢在页面级 keydown 之前）；点遮罩取消；Tab 在卡片内循环；
 * - 明暗主题走 token，浮层阴影用自包含字面值（不引用 --shadow-*，运行时是大投影）。
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // 打开时把焦点放到「取消」：Enter / 空格按原生按钮行为落在取消上，不会误删。
  // 只依赖 open——回调身份每次渲染都会变，混进依赖会让 effect 重跑、把用户
  // Tab 到「确认」上的焦点强行拽回「取消」（弹窗打开期间条目刷新就会触发）。
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // 捕获阶段监听：抢在页面级 keydown（如暂存架排序的 Esc）之前处理。
    // 有意不接管 Enter：焦点按钮的原生激活行为就是正确语义，全局 Enter→确认
    // 会在焦点位于「取消」时误执行破坏性操作。
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key === "Tab") {
        const buttons = Array.from(
          cardRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        );
        if (buttons.length === 0) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? (index - 1 + buttons.length) % buttons.length
          : (index + 1) % buttons.length;
        buttons[next].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;
  return (
    <div className="confirm-dialog-veil" onPointerDown={onCancel} role="presentation">
      <div
        ref={cardRef}
        className={`confirm-dialog-card${danger ? " is-danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="confirm-dialog-icon" aria-hidden="true">
          <Icon name="AlertCircle" size={20} />
        </span>
        <p className="confirm-dialog-title">{title}</p>
        {description != null && <p className="confirm-dialog-desc">{description}</p>}
        <div className="confirm-dialog-actions">
          <button type="button" ref={cancelRef} className="confirm-dialog-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-dialog-btn is-confirm${danger ? " is-danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
