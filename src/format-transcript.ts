import type { SubagentSessionData, ToolCallPart } from "./types";
import type { Message } from "@earendil-works/pi-ai";
import { extractTextParts } from "./utils";

const TOOL_CALL_PREVIEW_LENGTH = 120;
const TOOL_RESULT_TRUNCATION_LENGTH = 500;

/**
 * Options controlling how transcript runs are formatted.
 */
export interface TranscriptOptions {
  /** Whether to include user messages in the transcript */
  includeUserMessages: boolean;
  /** Prefix for user messages */
  userPrefix: string;
  /** Prefix for assistant text messages */
  assistantPrefix: string;
  /** Prefix format for tool calls. Use `{name}` and `{args}` placeholders */
  toolCallPrefix: string;
  /** Prefix for tool result messages */
  toolResultPrefix: string;
  /** Maximum characters for tool result text before truncation */
  toolResultTruncation: number;
  /** Maximum characters for tool call arguments preview */
  toolCallPreviewLength: number;
  /** Separator used between formatted parts/lines */
  partSeparator: string;
  /**
   * Function to format the run header when there are multiple runs.
   * Receives (runIndex, totalRuns, run). Return undefined to skip header.
   */
  runHeader: (runIndex: number, totalRuns: number, run: SubagentSessionData) => string | undefined;
}

/** Format tool calls from an assistant message's content. */
function formatToolCalls(
  content: Message["content"],
  prefix: string,
  previewLength: number,
): string[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  const results: string[] = [];
  for (const part of content) {
    if (part.type === "toolCall") {
      const toolCall = part as ToolCallPart;
      const args = JSON.stringify(toolCall.arguments || {}).slice(0, previewLength);
      results.push(prefix.replace("{name}", toolCall.name).replace("{args}", args));
    }
  }
  return results;
}

/** Format a single message into transcript lines. */
function formatMessage(msg: Message, options: TranscriptOptions): string[] {
  const parts: string[] = [];

  if (msg.role === "user" && options.includeUserMessages) {
    const text = getTextContent(msg);
    if (text) parts.push(`${options.userPrefix}${text}`);
  } else if (msg.role === "assistant") {
    const text = getTextContent(msg);
    if (text) parts.push(`${options.assistantPrefix}${text}`);
    parts.push(...formatToolCalls(msg.content, options.toolCallPrefix, options.toolCallPreviewLength));
  } else if (msg.role === "toolResult") {
    const text = getTextContent(msg);
    if (text) {
      const truncated =
        text.length > options.toolResultTruncation
          ? `${text.slice(0, options.toolResultTruncation)}...`
          : text;
      parts.push(`${options.toolResultPrefix}${truncated}`);
    }
  }

  return parts;
}

/**
 * Format a complete transcript from an array of runs.
 * Iterates over runs, extracts text/tool calls/tool results from messages,
 * applies role prefixes, truncates tool call args and tool results, and
 * adds run separators.
 */
export function formatTranscript(runs: SubagentSessionData[], options: TranscriptOptions): string {
  const parts: string[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const header = options.runHeader(i, runs.length, run);
    if (header) parts.push(header);

    for (const msg of run.messages) {
      parts.push(...formatMessage(msg, options));
    }

    if (run.errorMessage) {
      parts.push(`[Error: ${run.errorMessage}]`);
    }
  }

  return parts.join(options.partSeparator);
}

/**
 * Options for formatting runs when resuming a sub-agent session.
 */
export const RESUME_OPTIONS: TranscriptOptions = {
  includeUserMessages: true,
  userPrefix: "User: ",
  assistantPrefix: "Assistant: ",
  toolCallPrefix: "Tool Call: {name}({args})",
  toolResultPrefix: "Tool Result: ",
  toolResultTruncation: TOOL_RESULT_TRUNCATION_LENGTH,
  toolCallPreviewLength: TOOL_CALL_PREVIEW_LENGTH,
  partSeparator: "\n\n",
  runHeader: (i, total, run) =>
    total > 1
      ? `--- Run ${i + 1} (${run.status}, ${run.messages.length} messages) ---`
      : undefined,
};

/**
 * Options for formatting runs when retrieving a session transcript via tool.
 */
export const RETRIEVAL_OPTIONS: TranscriptOptions = {
  includeUserMessages: false,
  userPrefix: "",
  assistantPrefix: "",
  toolCallPrefix: "→ {name}: {args}",
  toolResultPrefix: "[tool result]: ",
  toolResultTruncation: TOOL_RESULT_TRUNCATION_LENGTH,
  toolCallPreviewLength: TOOL_CALL_PREVIEW_LENGTH,
  partSeparator: "\n---\n",
  runHeader: (i, total, run) =>
    total > 1 ? `=== Run ${i + 1}/${total} (${run.status}) ===` : undefined,
};

/**
 * Format previous runs' session data for inclusion in a resume prompt.
 * Produces a human-readable transcript of all previous runs.
 */
export function formatRunsForResume(runs: SubagentSessionData[]): string {
  return formatTranscript(runs, RESUME_OPTIONS);
}

/** Extract text content from a Message */
export function getTextContent(msg: { content?: unknown }): string | undefined {
  const parts = extractTextParts(msg);
  return parts.length > 0 ? parts.join("\n") : undefined;
}
