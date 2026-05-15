/**
 * pi-subagents Extension Utilities
 *
 * Helper functions for subagent processing, output formatting, and concurrency management.
 */

import { homedir } from "node:os";
import { relative } from "node:path";
import { MAX_MESSAGES_PER_SESSION } from "./types";
import type { SubAgentWindow } from "./types";
import type { Message } from "@earendil-works/pi-ai";

const HOME = homedir();

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

// ── Path Shortening ──────────────────────────────────────────────────────

/**
 * Shortens a single absolute file path relative to the given cwd.
 * - Replaces home directory prefix with `~`
 * - Uses relative path from cwd if shorter
 */
export function shortenPath(absolutePath: string, cwd: string): string {
  if (absolutePath === cwd) {return ".";}

  let displayPath = absolutePath;
  if (absolutePath.startsWith(`${HOME}/`)) {
    displayPath = `~${absolutePath.slice(HOME.length)}`;
  }

  const rel = relative(cwd, absolutePath);

  if (rel !== "" && rel !== "." && rel.length < displayPath.length) {
    // For ascending paths (..), only use if significantly shorter to avoid confusing output
    if (rel.startsWith("..")) {
      const savings = displayPath.length - rel.length;
      if (savings < 10) {return displayPath;}
    }
    return rel;
  }

  return displayPath;
}

/** Regex to match candidate absolute paths (at least 2 segments, starting with /) */
const ABSOLUTE_PATH_REGEX = /(?:^|[^:\w/])((?:\/[a-zA-Z0-9._-]+){2,})/g;

/**
 * Finds absolute paths in arbitrary text and shortens them.
 * Excludes URLs (preceded by `://`).
 */
export function shortenPathsInText(text: string, cwd: string): string {
  const matches: Array<{ match: string; index: number }> = [];
  ABSOLUTE_PATH_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null = ABSOLUTE_PATH_REGEX.exec(text);
  while (m !== null) {
    if (m[1]) {
      matches.push({ match: m[1], index: m.index + (m[0].length - m[1].length) });
    }
    m = ABSOLUTE_PATH_REGEX.exec(text);
  }

  if (matches.length === 0) {return text;}

  // Build result by replacing each match
  let result = "";
  let lastEnd = 0;

  for (const { match, index } of matches) {
    result += text.slice(lastEnd, index);
    result += shortenPath(match, cwd);
    lastEnd = index + match.length;
  }
  result += text.slice(lastEnd);
  return result;
}

/**
 * Handles the common pattern where the cwd appears in cd commands.
 * - `cd <cwd> && ...` → strips the `cd <cwd> &&` prefix
 * - `cd <cwd>` exactly → returns `.`
 * - `cd <cwd> &&` with nothing after → returns empty string
 */
let _cdCwd = "";
let _cdPattern: RegExp | null = null;

function getCdPattern(cwd: string): RegExp {
  if (cwd !== _cdCwd) {
    _cdCwd = cwd;
    const escapedCwd = cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    _cdPattern = new RegExp(`^cd\\s+${escapedCwd}(\\s+&&\\s*(.*))?$`);
  }
  return _cdPattern as RegExp;
}

export function collapseCdDot(command: string, cwd: string): string {
  const match = command.match(getCdPattern(cwd));

  if (!match) {return command;}

  if (match[1] === undefined) {
    // Exact match: `cd <cwd>` with nothing after → return "."
    return ".";
  }

  // Has `&&` part
  const after = match[2] ?? "";
  if (after.trim() === "") {
    // `cd <cwd> &&` with nothing after → return empty string
    return "";
  }

  // `cd <cwd> && ...` → strip prefix, return the rest
  return after.trimStart();
}

// ── Bash Command Formatting ────────────────────────────────────────

/**
 * Format a bash command with smart && splitting for display.
 *
 * Splits on ` && ` boundaries, greedily fits segments into the width budget.
 * When the next segment won't fit in the remaining width, starts a new line.
 * When a single segment is too long, truncates with `...`.
 * Continuation lines are prefixed with `│ ` for visual grouping.
 *
 * @param cmd - The bash command string (already collapsed/stripped of cd prefix)
 * @param firstLineBudget - Maximum characters for the first line of command content
 * @param contBudget - Maximum characters for continuation lines (command text only,
 *   excluding the `│ ` prefix). Defaults to `firstLineBudget`.
 * @returns Formatted multi-line string (continuation lines include `│ ` prefix)
 */
export function formatBashCommand(cmd: string, firstLineBudget: number, contBudget?: number): string {
  const contLineBudget = contBudget ?? firstLineBudget;

  if (cmd.length <= firstLineBudget) {return cmd;}

  // Split on " && " boundaries
  const segments = cmd.split(" && ");

  if (segments.length === 1) {
    // Single segment, just truncate
    return `${cmd.slice(0, firstLineBudget - 3)}...`;
  }

  const lines: string[] = [];
  let currentLine = "";
  let isFirstLine = true;
  const separator = " &&"; // goes at end of line when wrapping
  const contPrefix = "\u2502 "; // \u2502 = │ prefix for continuation lines

  for (let i = 0; i < segments.length; i++) {
    const budget = isFirstLine && currentLine.length === 0 ? firstLineBudget : contLineBudget;
    const seg = segments[i];

    if (currentLine.length === 0) {
      // Start of a new line
      if (seg.length <= budget) {
        currentLine = `${isFirstLine ? "" : contPrefix}${seg}`;
      } else {
        // Segment too long even on its own line — truncate it
        const truncated = `${seg.slice(0, budget - 3)}...`;
        // If there are more segments after this, we need " &&" suffix
        if (i < segments.length - 1) {
          lines.push(`${isFirstLine ? "" : contPrefix}${truncated} &&`);
        } else {
          lines.push(`${isFirstLine ? "" : contPrefix}${truncated}`);
        }
        isFirstLine = false;
        currentLine = "";
      }
    } else {
      // Try to append to current line
      const withSeg = `${currentLine} && ${seg}`;
      if (withSeg.length <= budget) {
        currentLine = withSeg;
      } else {
        // Won't fit — flush current line with separator and start new line
        lines.push(`${currentLine}${separator}`);
        isFirstLine = false;

        // Now try to fit seg on a new continuation line
        if (seg.length <= contLineBudget) {
          currentLine = `${contPrefix}${seg}`;
        } else {
          // Segment too long on its own
          const truncated = `${seg.slice(0, contLineBudget - 3)}...`;
          if (i < segments.length - 1) {
            lines.push(`${contPrefix}${truncated} &&`);
          } else {
            lines.push(`${contPrefix}${truncated}`);
          }
          currentLine = "";
        }
      }
    }
  }

  // Flush remaining
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.join("\n");
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

/**
 * Determine how to invoke the pi binary.
 * Returns the command and arguments needed to spawn a sub-agent process.
 */
export function getPiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}
