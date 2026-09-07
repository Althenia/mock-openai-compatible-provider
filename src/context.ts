import { createHash } from "node:crypto"

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      const item = record(part)
      return typeof item?.text === "string" ? item.text : ""
    })
    .join("\n")
}

export function estimateTokens(value: string) {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3)
}

export function compactionDigest(messages: unknown) {
  if (!Array.isArray(messages)) return undefined
  let latest: string | undefined
  for (const candidate of messages) {
    const message = record(candidate)
    if (message?.role !== "user") continue
    const content = text(message.content).trim()
    if (
      content.startsWith("<conversation-checkpoint>\n") &&
      content.includes("\n<summary>\n") &&
      content.includes("\n</summary>\n") &&
      content.endsWith("\n</conversation-checkpoint>")
    )
      latest = content
  }
  return latest ? createHash("sha256").update(latest).digest("hex") : undefined
}
