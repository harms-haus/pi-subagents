/**
 * Tool Call Formatting
 *
 * Functions for formatting tool call previews and result summaries.
 * Path shortening and bash command formatting live in their own modules.
 */

import { shortenPath, shortenPathsInText } from "./format-path";
import {
  BASH_CONT_PREFIX_WIDTH,
  BASH_PREFIX_WIDTH,
  collapseCdDot,
  formatBashCommand,
} from "./format-bash";

// ── Re-exports for backward compatibility ────────────────────────────
export { shortenPath, shortenPathsInText } from "./format-path";
export {
  BASH_CONT_PREFIX_WIDTH,
  BASH_PREFIX_WIDTH,
  collapseCdDot,
  formatBashCommand,
} from "./format-bash";

export const TOOL_EMOJI: Record<string, string> = {
  grep: "🔍",
  find: "🔍",
  web_search: "🔍",
  read: "📖",
  edit: "✏️",
  write: "📝",
  ls: "📂",
  bash: "💻",
  delegate_to_subagents: "🤝",
  get_subagent_output: "📋",
  get_subagent_session: "📋",
  list_subagent_profiles: "👥",
  write_todos: "✅",
  edit_todos: "✅",
  list_todos: "✅",
  lsp_diagnostics: "🏥",
  lsp_find_references: "🔗",
  lsp_goto_definition: "🔗",
  lsp_find_symbol: "🔎",
  lsp_call_hierarchy: "🔗",
  lsp_refactor_symbol: "✏️",
  fetch_content: "🌐",
  fetch_repo: "📥",
  lint_files: "🧹",
  workflow_step: "▶️",
};

export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJI[toolName] ?? "🔧";
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

function countOutputEntries(text: string): number {
  let count = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      if (i > lineStart && text.charCodeAt(lineStart) !== 91) count++;
      lineStart = i + 1;
    }
  }
  return count;
}

function countDirsInOutput(text: string): number {
  let dirs = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      if (i > lineStart && text.charCodeAt(lineStart) !== 91) {
        const ch = text.charCodeAt(i - 1);
        if (ch === 47 || ch === 92) {
          dirs++;
        }
      }
      lineStart = i + 1;
    }
  }
  return dirs;
}

function isEmptyLsOutput(text: string): boolean {
  return !text || text === "(empty directory)" || text === "(empty directory)\n";
}

function formatLsResultText(
  text: string,
  details?: { entryLimitReached?: number },
  inline?: boolean,
): string {
  const prefix = inline ? "" : "  ";
  if (isEmptyLsOutput(text)) {
    return `${prefix}(empty)`;
  }
  const dirs = countDirsInOutput(text);
  const total = countOutputEntries(text);
  const files = total - dirs;
  if (dirs === 0 && files === 0) {
    return `${prefix}(empty)`;
  }
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files !== 1 ? "s" : ""}`);
  if (dirs > 0) parts.push(`${dirs} dir${dirs !== 1 ? "s" : ""}`);
  const truncationIndicator = details?.entryLimitReached ? "+" : "";
  return `${prefix}${parts.join(", ")}${truncationIndicator}`;
}

function formatFindResultText(
  text: string,
  details?: { resultLimitReached?: number },
  inline?: boolean,
): string {
  const prefix = inline ? "" : "  ";
  if (
    !text ||
    text === "No files found matching pattern" ||
    text === "No files found matching pattern\n"
  ) {
    return `${prefix}0 matches`;
  }
  const count = countOutputEntries(text);
  const truncationIndicator = details?.resultLimitReached ? "+" : "";
  return `${prefix}${count} match${count !== 1 ? "es" : ""}${truncationIndicator}`;
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
 * Like formatToolResult but returns the summary WITHOUT leading spaces.
 * Returns null for unsupported tool names.
 */
export function formatToolResultInline(
  toolName: string,
  resultText: string,
  details?: Record<string, unknown>,
): string | null {
  if (toolName === "ls") {
    return formatLsResultText(resultText, details, true);
  }
  if (toolName === "find") {
    return formatFindResultText(resultText, details, true);
  }
  return null;
}

// ── formatToolCall case helpers ────────────────────────────────────

function formatEditCall(
  a: Record<string, string>,
  args: Record<string, unknown>,
  cwd: string,
): string {
  const path = shortenPath(a.path || a.filePath || "...", cwd);
  const edits = (args.edits as Array<{ oldText?: string; newText?: string }> | undefined) ?? [];
  const count = edits.length;
  const suffix = count ? ` (${count} edit${count > 1 ? "s" : ""})` : "";
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    removed += countNonEmptyLines(edit.oldText ?? "");
    added += countNonEmptyLines(edit.newText ?? "");
  }
  const diffStats = count > 0 ? ` +${added}/-${removed}` : "";
  return `edit → ${path}${suffix}${diffStats}`;
}

function formatWriteCall(a: Record<string, string>, cwd: string): string {
  const path = shortenPath(a.path || a.filePath || "...", cwd);
  const content = a.content || "";
  const lines = countNonEmptyLines(content);
  return `write → ${path} +${lines}`;
}

function formatGrepCall(a: Record<string, string>, cwd: string): string {
  const pattern = a.pattern || "...";
  if (a.glob) {
    return `grep → /${pattern}/ → ${a.glob}`;
  } else if (a.path) {
    return `grep → /${pattern}/ → ${shortenPath(a.path, cwd)}`;
  }
  return `grep → /${pattern}/`;
}

function formatBashCall(a: Record<string, string>, cwd: string, widthBudget: number): string {
  let cmd = (a.command || "...").split("\n")[0] ?? "...";
  cmd = collapseCdDot(cmd, cwd);
  if (cmd === "." || cmd === "") {
    return `bash → cd .`;
  }
  cmd = shortenPathsInText(cmd, cwd);
  return `bash → ${formatBashCommand(cmd, widthBudget - BASH_PREFIX_WIDTH, widthBudget - BASH_CONT_PREFIX_WIDTH)}`;
}

function formatReadCall(a: Record<string, string>, cwd: string): string {
  const path = shortenPath(a.path || "...", cwd);
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

function formatDelegateCall(a: Record<string, string>, args: Record<string, unknown>): string {
  const tasks = (args.tasks || []) as { profile?: string }[];
  const profiles = tasks.map((t) => t.profile).filter(Boolean);
  const profileStr =
    profiles.length > 0 ? ` [${profiles.join(", ")}]` : a.profile ? ` [${a.profile}]` : "";
  return `delegate_to_subagents → ${tasks.length} task${tasks.length !== 1 ? "s" : ""}${profileStr}`;
}

function formatWriteTodosCall(args: Record<string, unknown>): string {
  const n = (args.todos as unknown[] | undefined)?.length ?? 0;
  return `write_todos → ${n} todos written`;
}

function formatLspRefactorSymbolCall(a: Record<string, string>, cwd: string): string {
  const file = shortenPath(a.file || "...", cwd);
  return `lsp_refactor_symbol → ${file}:${a.line}:${a.column} → ${a.newName || "..."}`;
}

function formatFetchRepoCall(a: Record<string, string>): string {
  return `fetch_repo → ${a.url || "..."}`;
}

function formatSessionCall(toolName: string, args: Record<string, unknown>): string {
  const sessionId = (args.sessionId as string) || "...";
  return `${toolName} → ${sessionId}`;
}

function formatWorkflowStepCall(args: Record<string, unknown>): string {
  const action = (args.action as string) || "?";
  return `workflow_step → ${action}`;
}

function formatLsCall(a: Record<string, string>, cwd: string): string {
  const path = a.path ? shortenPath(a.path, cwd) : ".";
  return `ls → ${path}`;
}

function formatFindCall(a: Record<string, string>, cwd: string): string {
  const pattern = a.pattern || "...";
  if (a.path) {
    return `find → ${pattern} in ${shortenPath(a.path, cwd)}`;
  }
  return `find → ${pattern}`;
}

function formatLspFindSymbolCall(a: Record<string, string>): string {
  return `lsp_find_symbol → ${a.query || "..."}`;
}

function formatEditTodosCall(args: Record<string, unknown>): string {
  const action = (args.action as string) || "?";
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

function formatLspFileCall(toolName: string, a: Record<string, string>, cwd: string): string {
  const file = shortenPath(a.file || "...", cwd);
  return `${toolName} → ${file}`;
}

function formatLspPositionCall(toolName: string, a: Record<string, string>, cwd: string): string {
  const file = shortenPath(a.file || "...", cwd);
  return `${toolName} → ${file}:${a.line}:${a.column}`;
}

function formatLintFilesCall(args: Record<string, unknown>, cwd: string): string {
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

function formatFetchCall(toolName: string, a: Record<string, string>, widthBudget: number): string {
  const url = a.url || a.query || "...";
  const urlBudget = widthBudget - toolName.length - 4;
  const truncated = url.length > urlBudget ? `${url.slice(0, urlBudget - 3)}...` : url;
  return `${toolName} → ${truncated}`;
}

function formatDefaultCall(
  toolName: string,
  args: Record<string, unknown>,
  widthBudget: number,
): string {
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

const TOOL_FORMATTERS: Partial<
  Record<
    string,
    (
      a: Record<string, string>,
      args: Record<string, unknown>,
      cwd: string,
      widthBudget: number,
    ) => string
  >
> = {
  edit: (a, args, cwd) => formatEditCall(a, args, cwd),
  write: (a, _args, cwd) => formatWriteCall(a, cwd),
  grep: (a, _args, cwd) => formatGrepCall(a, cwd),
  bash: (a, _args, cwd, widthBudget) => formatBashCall(a, cwd, widthBudget),
  read: (a, _args, cwd) => formatReadCall(a, cwd),
  delegate_to_subagents: (a, args) => formatDelegateCall(a, args),
  write_todos: (_a, args) => formatWriteTodosCall(args),
  edit_todos: (_a, args) => formatEditTodosCall(args),
  list_todos: () => "list_todos",
  lsp_diagnostics: (a, _args, cwd) => formatLspFileCall("lsp_diagnostics", a, cwd),
  lsp_find_references: (a, _args, cwd) => formatLspPositionCall("lsp_find_references", a, cwd),
  lsp_goto_definition: (a, _args, cwd) => formatLspPositionCall("lsp_goto_definition", a, cwd),
  lsp_find_symbol: (a) => formatLspFindSymbolCall(a),
  lsp_call_hierarchy: (a, _args, cwd) => formatLspPositionCall("lsp_call_hierarchy", a, cwd),
  lsp_refactor_symbol: (a, _args, cwd) => formatLspRefactorSymbolCall(a, cwd),
  lint_files: (_a, args, cwd) => formatLintFilesCall(args, cwd),
  fetch_content: (a, _args, _cwd, widthBudget) => formatFetchCall("fetch_content", a, widthBudget),
  web_search: (a, _args, _cwd, widthBudget) => formatFetchCall("web_search", a, widthBudget),
  fetch_repo: (a) => formatFetchRepoCall(a),
  get_subagent_output: (_a, args) => formatSessionCall("get_subagent_output", args),
  get_subagent_session: (_a, args) => formatSessionCall("get_subagent_session", args),
  list_subagent_profiles: () => "list_subagent_profiles",
  workflow_step: (_a, args) => formatWorkflowStepCall(args),
  ls: (a, _args, cwd) => formatLsCall(a, cwd),
  find: (a, _args, cwd) => formatFindCall(a, cwd),
};

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
  const a = args as Record<string, string>;
  const formatter = TOOL_FORMATTERS[toolName];
  if (formatter) {
    return formatter(a, args, cwd, widthBudget);
  }
  return formatDefaultCall(toolName, args, widthBudget);
}
