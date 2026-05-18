/**
 * Tool Call Formatting & Path/Bash Utilities
 *
 * Functions for formatting tool call previews and shortening paths/collapsing
 * cd commands in sub-agent output.
 */

import { homedir } from "node:os";
import { relative } from "node:path";

const HOME = homedir();

// ── Path Shortening ──────────────────────────────────────────────────────

/**
 * Shortens a single absolute file path relative to the given cwd.
 * - Replaces home directory prefix with `~`
 * - Uses relative path from cwd if shorter
 */
export function shortenPath(absolutePath: string, cwd: string): string {
  if (absolutePath === cwd) {
    return ".";
  }

  let displayPath = absolutePath;
  if (absolutePath.startsWith(`${HOME}/`)) {
    displayPath = `~${absolutePath.slice(HOME.length)}`;
  }

  const rel = relative(cwd, absolutePath);

  if (rel !== "" && rel !== "." && rel.length < displayPath.length) {
    // For ascending paths (..), only use if significantly shorter to avoid confusing output
    if (rel.startsWith("..")) {
      const savings = displayPath.length - rel.length;
      if (savings < 10) {
        return displayPath;
      }
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

  if (matches.length === 0) {
    return text;
  }

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

  if (!match) {
    return command;
  }

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
export function formatBashCommand(
  cmd: string,
  firstLineBudget: number,
  contBudget?: number,
): string {
  const contLineBudget = contBudget ?? firstLineBudget;

  if (cmd.length <= firstLineBudget) {
    return cmd;
  }

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

// ── Tool Call Formatting ────────────────────────────────────────────

/**
 * Count non-empty lines in a text without allocating intermediate arrays.
 */
export function countNonEmptyLines(text: string): number {
  let count = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      // newline
      let empty = true;
      for (let j = lineStart; j < i; j++) {
        const c = text.charCodeAt(j);
        if (c !== 32 && c !== 9 && c !== 13) {
          // not space/tab/CR
          empty = false;
          break;
        }
      }
      if (!empty) {
        count++;
      }
      lineStart = i + 1;
    }
  }
  return count;
}

function formatLsResultText(text: string, details?: { entryLimitReached?: number }): string {
  if (!text || text === "(empty directory)" || text === "(empty directory)\n") {
    return "  (empty)";
  }
  let dirs = 0;
  let files = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      if (i > lineStart && text.charCodeAt(lineStart) !== 91) { // skip empty and '[' lines
        if (text.charCodeAt(i - 1) === 47) dirs++; else files++; // 47 = '/', trailing slash = dir
      }
      lineStart = i + 1;
    }
  }
  if (dirs === 0 && files === 0) {
    return "  (empty)";
  }
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files !== 1 ? "s" : ""}`);
  if (dirs > 0) parts.push(`${dirs} dir${dirs !== 1 ? "s" : ""}`);
  const truncationIndicator = details?.entryLimitReached ? "+" : "";
  return `  ${parts.join(", ")}${truncationIndicator}`;
}

function formatFindResultText(text: string, details?: { resultLimitReached?: number }): string {
  if (!text || text === "No files found matching pattern" || text === "No files found matching pattern\n") {
    return "  0 matches";
  }
  let count = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      if (i > lineStart && text.charCodeAt(lineStart) !== 91) {
        count++;
      }
      lineStart = i + 1;
    }
  }
  const truncationIndicator = details?.resultLimitReached ? "+" : "";
  return `  ${count} match${count !== 1 ? "es" : ""}${truncationIndicator}`;
}

export function formatToolResult(
  toolName: string,
  resultText: string,
  details?: Record<string, unknown>,
): string | null {
  if (toolName === "ls") {
    return formatLsResultText(resultText, details);
  }
  if (toolName === "find") {
    return formatFindResultText(resultText, details);
  }
  return null;
}

/**
 * Format a tool call as a concise one-liner for the sub-agent rolling window.
 * Avoids dumping full JSON arguments for common tools.
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  widthBudget: number,
): string {
  // Typed view of args for display formatting
  const a = args as Record<string, string>;
  switch (toolName) {
    // File mutations: just show the filename
    case "edit": {
      const path = shortenPath(a.path ?? a.filePath ?? "...", cwd);
      const edits = (args.edits as Array<{ oldText?: string; newText?: string }> | undefined) ?? [];
      const count = edits.length;
      const suffix = count ? ` (${count} edit${count > 1 ? "s" : ""})` : "";
      // Count lines added/removed from edits
      let added = 0;
      let removed = 0;
      for (const edit of edits) {
        removed += countNonEmptyLines(edit.oldText ?? "");
        added += countNonEmptyLines(edit.newText ?? "");
      }
      const diffStats = count > 0 ? ` +${added}/-${removed}` : "";
      return `edit → ${path}${suffix}${diffStats}`;
    }

    case "write": {
      const path = shortenPath(a.path ?? a.filePath ?? "...", cwd);
      const content = a.content ?? "";
      const lines = countNonEmptyLines(content);
      return `write → ${path} +${lines}`;
    }

    case "grep": {
      const pattern = a.pattern ?? "...";
      if (a.glob) {
        return `grep → /${pattern}/ → ${a.glob}`;
      } else if (a.path) {
        return `grep → /${pattern}/ → ${shortenPath(a.path, cwd)}`;
      }
      return `grep → /${pattern}/`;
    }

    case "bash": {
      let cmd = (a.command ?? "...").split("\n")[0];
      cmd = collapseCdDot(cmd, cwd);
      if (cmd === "." || cmd === "") {
        return `bash → cd .`;
      }
      cmd = shortenPathsInText(cmd, cwd);
      return `bash → ${formatBashCommand(cmd, widthBudget - 12, widthBudget - 5)}`;
    }

    case "read": {
      const path = shortenPath(a.path ?? "...", cwd);
      const parts = [path];
      if (a.offset) {
        parts.push(`:${a.offset}`);
      }
      if (a.limit) {
        parts.push(`+${a.limit}`);
      }
      const lineCount = a.limit ? ` (${a.limit} lines)` : "";
      return `read → ${parts.join("")}${lineCount}`;
    }

    // Delegation
    case "delegate_to_subagents": {
      const tasks = (args.tasks ?? []) as { profile?: string }[];
      const profiles = tasks.map((t) => t.profile).filter(Boolean);
      const profileStr =
        profiles.length > 0 ? ` [${profiles.join(", ")}]` : a.profile ? ` [${a.profile}]` : "";
      return `delegate_to_subagents → ${tasks.length} task${tasks.length !== 1 ? "s" : ""}${profileStr}`;
    }

    // Todo tools
    case "write_todos": {
      const n = (args.todos as unknown[] | undefined)?.length ?? 0;
      return `write_todos → ${n} todos written`;
    }
    case "edit_todos": {
      const action = (args.action as string) ?? "?";
      const indices = (args.indices as number[] | undefined) ?? [];
      const todos = args.todos as Array<{ text?: string }> | undefined;
      let desc: string;
      if (todos && todos.length > 0) {
        desc = todos.map((t) => t.text ?? "").join(", ");
        if (desc.length > 48) {
          desc = `${desc.slice(0, 45)}...`;
        }
      } else {
        desc = `${action} [${indices.join(",")}]`;
      }
      return `edit_todos → ${desc}`;
    }
    case "list_todos":
      return "list_todos";

    // LSP tools
    case "lsp_diagnostics": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_diagnostics → ${file}`;
    }
    case "lsp_find_references": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_find_references → ${file}:${a.line}:${a.column}`;
    }
    case "lsp_goto_definition": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_goto_definition → ${file}:${a.line}:${a.column}`;
    }
    case "lsp_find_symbol":
      return `lsp_find_symbol → ${a.query ?? "..."}`;
    case "lsp_call_hierarchy": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_call_hierarchy → ${file}:${a.line}:${a.column}`;
    }
    case "lsp_refactor_symbol": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_refactor_symbol → ${file}:${a.line}:${a.column} → ${a.newName ?? "..."}`;
    }

    // Lint
    case "lint_files": {
      const files = args.files as string[] | undefined;
      if (files && files.length > 0) {
        const shortened = files.map((f) => shortenPath(f, cwd));
        const preview =
          shortened.length <= 3
            ? shortened.join(", ")
            : `${shortened.slice(0, 2).join(", ")}, ... +${shortened.length - 2} more`;
        return `lint → ${preview}`;
      }
      return "lint → (all)";
    }

    // Fetch tools
    case "fetch_content":
    case "web_search": {
      const url = a.url ?? a.query ?? "...";
      const urlBudget = widthBudget - toolName.length - 4;
      const truncated = url.length > urlBudget ? `${url.slice(0, urlBudget - 3)}...` : url;
      return `${toolName} → ${truncated}`;
    }
    case "fetch_repo": {
      const url = a.url ?? "...";
      return `fetch_repo → ${url}`;
    }

    // Session retrieval
    case "get_subagent_output":
      return `get_subagent_output → ${(args.sessionId as string) ?? "..."}`;
    case "get_subagent_session":
      return `get_subagent_session → ${(args.sessionId as string) ?? "..."}`;
    case "list_subagent_profiles":
      return "list_subagent_profiles";

    // Workflow
    case "workflow_step": {
      const action = (args.action as string) ?? "?";
      return `workflow_step → ${action}`;
    }

    // File listing
    case "ls": {
      const path = a.path ? shortenPath(a.path, cwd) : ".";
      return `ls → ${path}`;
    }

    case "find": {
      const pattern = a.pattern ?? "...";
      if (a.path) {
        return `find → ${pattern} in ${shortenPath(a.path, cwd)}`;
      }
      return `find → ${pattern}`;
    }

    default: {
      const argsStr = JSON.stringify(args);
      const budget = widthBudget - toolName.length - 1;
      if (argsStr === "{}") {
        return toolName;
      }
      if (argsStr.length > budget) {
        return `${toolName} ${argsStr.slice(0, Math.max(0, budget - 3))}...`;
      }
      return `${toolName} ${argsStr}`;
    }
  }
}
