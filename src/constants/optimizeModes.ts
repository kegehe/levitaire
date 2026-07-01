import type { IconName } from "../components/Icon";

/** 优化模式定义 */
export interface OptimizeMode {
  /** 模式唯一标识 */
  id: string;
  /** 图标名称（IconName） */
  icon: IconName;
  /** 显示标签 */
  label: string;
  /** AI 系统提示词 */
  systemPrompt: string;
}

/** 预设优化模式列表 */
export const OPTIMIZE_MODES: OptimizeMode[] = [
  {
    id: "polish",
    icon: "Sparkles",
    label: "润色",
    systemPrompt:
      "你是一个文本润色专家。请润色和优化以下文本，使其更流畅、更自然、更易读，保持原意不变。只返回润色后的文本，不要添加任何解释或前缀。",
  },
  {
    id: "formal",
    icon: "GraduationCap",
    label: "正式化",
    systemPrompt:
      "你是一个文本正式化专家。请将以下文本改写为更正式、更专业的风格，适合商务或学术场景，保持原意不变。只返回改写后的文本，不要添加任何解释或前缀。",
  },
  {
    id: "concise",
    icon: "Scissors",
    label: "简洁化",
    systemPrompt:
      "你是一个文本精简专家。请将以下文本精简为更简洁、更紧凑的版本，去除冗余表达，保持核心信息不变。只返回精简后的文本，不要添加任何解释或前缀。",
  },
  {
    id: "translate",
    icon: "Globe",
    label: "翻译",
    systemPrompt:
      "你是一个翻译专家。请将以下文本翻译为中文（如果原文是中文则翻译为英文），保持原文的语气和风格。只返回翻译后的文本，不要添加任何解释或前缀。",
  },
];
