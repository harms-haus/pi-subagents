import type { SubagentSessionData, ContentPart } from "./types";

/**
 * Format previous runs' session data for inclusion in a resume prompt.
 * Produces a human-readable transcript of all previous runs.
 */
export function formatRunsForResume(runs: SubagentSessionData[]): string {
  const parts: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (runs.length > 1) {
      parts.push(`--- Run ${i + 1} (${run.status}, ${run.messages.length} messages) ---`);
    }
    for (const msg of run.messages) {
      if (msg.role === "user") {
        const text = getTextContent(msg);
        if (text) {parts.push(`User: ${text}`);}
      } else if (msg.role === "assistant") {
        const text = getTextContent(msg);
        if (text) {parts.push(`Assistant: ${text}`);}
        // Extract tool calls
        if (msg.content) {
          for (const part of msg.content as ContentPart[]) {
            if (part.type === "toolCall") {
              const args = JSON.stringify(part.arguments || {}).slice(0, 120);
              parts.push(`Tool Call: ${part.name}(${args})`);
            }
          }
        }
      } else if (msg.role === "toolResult") {
        const text = getTextContent(msg);
        if (text) {
          const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text;
          parts.push(`Tool Result: ${truncated}`);
        }
      }
    }
    if (run.errorMessage) {
      parts.push(`[Error: ${run.errorMessage}]`);
    }
  }
  return parts.join("\n\n");
}

/** Extract text content from a Message */
export function getTextContent(msg: { content?: unknown }): string | undefined {
  if (!msg.content) {return undefined;}
  if (typeof msg.content === "string") {return msg.content;}
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content as ContentPart[]) {
      if (part.type === "text" && "text" in part && typeof part.text === "string") {texts.push(part.text);}
    }
    return texts.join("\n") || undefined;
  }
  return undefined;
}
