/**
 * pi-subagents Extension Utilities
 *
 * Helper functions for subagent processing, output formatting, and concurrency management.
 */

import { MAX_MESSAGES_PER_SESSION } from "./types";
import type { SubAgentWindow } from "./types";
import type { Message } from "@earendil-works/pi-ai";

// ── ANSI Stripping ───────────────────────────────────────────────────

/** Regex to match ANSI escape codes */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * Remove ANSI escape codes from text.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

// ── Rolling Buffer ─────────────────────────────────────────────────────

/**
 * Append a line to a sub-agent window, maintaining a rolling buffer.
 * The window keeps only the latest N lines but stores all messages separately.
 */
export function appendLineToWindow(
  win: SubAgentWindow,
  line: string,
  maxLines: number,
  kind: "text" | "tool" = "text",
): void {
  const clean = stripAnsi(line).trimEnd();
  if (!clean) {return;}
  const entry = { text: clean, kind };
  win.lines.push(entry);
  while (win.lines.length > maxLines) {
    win.lines.shift();
  }
  win.allMessages.push(entry);
  while (win.allMessages.length > MAX_MESSAGES_PER_SESSION) {
    win.allMessages.shift();
  }
}

// ── Session Helpers ──────────────────────────────────────────────────

/**
 * Extract all text content parts from a message.
 * Returns an array of text strings from the message content.
 */
export function getTextParts(msg: Message): string[] {
  if (msg.role !== "assistant" || !msg.content) {return [];}
  const parts: string[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push(part.text);
    }
  }
  return parts;
}

/**
 * Extract the last assistant text from a message array.
 * Scans backwards through messages to find the most recent assistant response.
 */
export function getLastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = getTextParts(messages[i]);
    if (parts.length > 0) {return parts[0];}
  }
  return "";
}

// ── Summary Formatting ───────────────────────────────────────────────

/**
 * Count windows by status.
 * Returns an object with counts for running, completed, and error states.
 */
export function countWindowStatuses(windows: SubAgentWindow[]): {
  running: number;
  completed: number;
  error: number;
} {
  return {
    running: windows.filter((w) => w.status === "running").length,
    completed: windows.filter((w) => w.status === "completed").length,
    error: windows.filter((w) => w.status === "error").length,
  };
}

/**
 * Generate a one-line status summary for multiple sub-agent windows.
 */
export function getSummaryText(windows: SubAgentWindow[]): string {
  const { running, completed: done, error: errors } = countWindowStatuses(windows);
  const parts: string[] = [];
  if (running > 0) {parts.push(`${running} running`);}
  if (done > 0) {parts.push(`${done} done`);}
  if (errors > 0) {parts.push(`${errors} error${errors > 1 ? "s" : ""}`);}
  return parts.join(", ") || "processing...";
}

// ── Concurrency Helper ───────────────────────────────────────────────

/**
 * Map an array with a concurrency limit.
 * Processes items in parallel but never more than `concurrency` at a time.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) {return [];}
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) {return;}
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Sub-Agent Spawner ────────────────────────────────────────────────
