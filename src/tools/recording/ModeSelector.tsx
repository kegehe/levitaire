import Icon from "../../components/Icon";
import type { RecordMode } from "./recordingConfig";

interface ModeSelectorProps {
  onSelect: (mode: RecordMode) => void;
  onCancel: () => void;
}

/** GIF/视频模式选择面板 */
function ModeSelector({ onSelect, onCancel }: ModeSelectorProps) {
  return (
    <div className="rec-mode-overlay" onPointerDown={(e) => e.stopPropagation()}>
      <div className="rec-mode-panel">
        <div className="rec-mode-title">选择录制模式</div>
        <div className="rec-mode-options">
          <button className="rec-mode-btn rec-mode-gif" onClick={() => onSelect("gif")}>
            <Icon name="Film" size={32} />
            <span className="rec-mode-btn-label">GIF 录制</span>
            <span className="rec-mode-btn-desc">适合短操作演示，文件小</span>
          </button>
          <button className="rec-mode-btn rec-mode-video" onClick={() => onSelect("video")}>
            <Icon name="Video" size={32} />
            <span className="rec-mode-btn-label">视频录制</span>
            <span className="rec-mode-btn-desc">高清 H.264 MP4，需 ffmpeg</span>
          </button>
        </div>
        <button className="rec-mode-cancel" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export default ModeSelector;
