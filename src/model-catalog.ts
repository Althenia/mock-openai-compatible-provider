import type { ThinkingLevel } from "./config.ts"

const COMMON_THINKING = ["low", "medium", "high"] as const

export const THINKING_LABELS: Readonly<Record<ThinkingLevel, readonly string[]>> = {
  low: ["Low", "ต่ำ"],
  medium: ["Medium", "ปกติ"],
  high: ["High", "สูง"],
  max: ["Max", "สูงที่สุด"],
}

export const MODELS: readonly {
  readonly id: string
  readonly name: string
  readonly thinking: readonly ThinkingLevel[]
}[] = [
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", thinking: [] },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", thinking: COMMON_THINKING },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (Preview)", thinking: COMMON_THINKING },
  { id: "claude-sonnet-5@default", name: "Claude Sonnet 5", thinking: COMMON_THINKING },
  { id: "claude-opus-5@azure", name: "Claude Opus 5", thinking: [...COMMON_THINKING, "max"] },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", thinking: COMMON_THINKING },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", thinking: COMMON_THINKING },
  { id: "DeepSeek-V3.2", name: "DeepSeek V3.2", thinking: [] },
  { id: "grok-4.3", name: "Grok 4.3", thinking: COMMON_THINKING },
  { id: "qwen3-next-80b-a3b-instruct-maas", name: "Qwen3-Next", thinking: [] },
  { id: "glm-5.2", name: "GLM 5.2", thinking: [] },
  { id: "Kimi-K2.7-Code", name: "Kimi K2.7 Code", thinking: [] },
  { id: "sonar", name: "Sonar", thinking: [] },
  { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro", thinking: COMMON_THINKING },
  { id: "Llama-4-Maverick-17B-128E-Instruct-FP8-1", name: "Llama 4 Maverick", thinking: [] },
  { id: "Llama-4-Scout-17B-16E-Instruct-1", name: "Llama 4 Scout", thinking: [] },
  { id: "minimax-m2-maas", name: "MiniMax M2", thinking: [] },
  { id: "Mistral-Large-3", name: "Mistral Large 3", thinking: [] },
  { id: "Mistral-Medium-3", name: "Mistral Medium 3", thinking: [] },
  { id: "pathumma-thaillm-8b", name: "Pathumma ThaiLLM 8B", thinking: COMMON_THINKING },
]
