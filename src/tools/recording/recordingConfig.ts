/** 录屏配置常量 */

/** GIF 帧率选项 */
export const GIF_FPS_OPTIONS = [5, 10, 15] as const;
/** 视频帧率选项 */
export const VIDEO_FPS_OPTIONS = [15, 30] as const;
/** GIF 最大时长选项（秒） */
export const MAX_DURATION_OPTIONS = [10, 30, 60] as const;

/** 默认 GIF 帧率 */
export const DEFAULT_GIF_FPS = 10;
/** 默认视频帧率 */
export const DEFAULT_VIDEO_FPS = 15;
/** 默认最大录制时长（秒） */
export const DEFAULT_MAX_DURATION = 30;

/** 录制模式 */
export type RecordMode = "gif" | "video";

/** 区域选择模式 */
export type AreaMode = "fullscreen" | "region" | "window";

/** 录制状态 */
export type RecordingPhase =
  | "idle"           // 未开始
  | "mode_select"    // 选择 GIF/视频模式
  | "area_select"    // 选择录制区域
  | "ready"          // 区域已选，准备录制
  | "recording"      // 录制中
  | "paused"         // 暂停中
  | "encoding"       // 编码中
  | "preview"        // 预览输出
  | "error";         // 错误

/** 窗口信息（后端 WindowInfo 的前端映射） */
export interface WindowInfo {
  hwnd: number;
  title: string;
  className: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 录制区域 */
export interface RecordRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}
