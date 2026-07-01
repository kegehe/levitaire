/** 选区信息 - 与后端 SelectionInfo 对应 */
export interface SelectionInfo {
  text: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/** AI 配置 - 与后端 AiConfig 对应 */
export interface AiConfig {
  api_key: string;
  base_url: string;
  model: string;
  /** API 类型："anthropic" 或 "openai" */
  api_type: string;
}
