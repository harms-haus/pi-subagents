/**
 * Delegate Rendering Functions
 *
 * Pure rendering functions for the delegate_to_subagents tool,
 * extracted for testability and reuse.
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { countWindowStatuses } from "../utils";
import type { SubAgentWindow, WindowedSubagentDetails, WindowLine } from "../types";
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

// ── Tool-line colorizing helpers ────────────────────────────────────────────

/**
 * Apply theme colors to specific patterns in tool call lines.
 * Colorizes diff stats (+N/-M) and line counts (N lines) while keeping
 * the rest of the line in muted color.
 */
export function colorizeToolLine(line: string, theme: Theme): string {
  return (
    colorizeDiffStats(line, theme) ??
    colorizeWriteCount(line, theme) ??
    colorizeReadLineCount(line, theme) ??
    colorizeInlineResult(line, theme) ??
    colorizeResultSummary(line, theme) ??
    theme.fg("muted", line)
  );
}

/** Pattern 1: +N/-M diff stats (edit tool) */
function colorizeDiffStats(line: string, theme: Theme): string | null {
  const m = line.match(/^(.*?)(\+\d+\/-\d+)(.*)$/);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  const prefix = m[1];
  const stats = m[2];
  const suffix = m[3];
  const plusIdx = stats.indexOf("+");
  const slashIdx = stats.indexOf("/");
  const added = stats.substring(plusIdx, slashIdx);
  const removed = stats.substring(slashIdx + 1);
  return (
    theme.fg("muted", prefix) +
    theme.fg("toolDiffAdded", added) +
    theme.fg("muted", "/") +
    theme.fg("toolDiffRemoved", removed) +
    theme.fg("muted", suffix)
  );
}

/** Pattern 2: +N at end (write tool, no removal count) */
function colorizeWriteCount(line: string, theme: Theme): string | null {
  if (!line.includes("write")) return null;
  const m = line.match(/^(.*?)(\+\d+)(\s*)$/);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return theme.fg("muted", m[1]) + theme.fg("toolDiffAdded", m[2]) + m[3];
}

/** Pattern 3: (N lines) line count (read tool) */
function colorizeReadLineCount(line: string, theme: Theme): string | null {
  const m = line.match(/^(.*?)(\()(\d+)( lines?\))(.*)$/);
  if (
    !m ||
    m[1] === undefined ||
    m[2] === undefined ||
    m[3] === undefined ||
    m[4] === undefined ||
    m[5] === undefined
  )
    return null;
  return (
    theme.fg("muted", m[1]) +
    theme.fg("muted", m[2]) +
    theme.fg("toolDiffAdded", m[3]) +
    theme.fg("muted", m[4]) +
    theme.fg("muted", m[5])
  );
}

/** Pattern 3.5: Inline ls/find result summaries (→ ls → <path> → <summary>) */
function colorizeInlineResult(line: string, theme: Theme): string | null {
  const m = line.match(/^(→ (?:ls|find) → .*? → )(\d+)(\s.*)$/);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  const count = m[2];
  if (count === "0") return theme.fg("muted", line);
  return theme.fg("muted", m[1]) + theme.fg("toolDiffAdded", count) + theme.fg("muted", m[3]);
}

/** Pattern 4: ls/find result summaries (indented lines with entry counts) */
function colorizeResultSummary(line: string, theme: Theme): string | null {
  const m = line.match(/^(\s{2})(\d+)(\s.*)$/);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return theme.fg("muted", m[1]) + theme.fg("toolDiffAdded", m[2]) + theme.fg("muted", m[3]);
}

// ── Delegate tool call rendering ────────────────────────────────────────────

/** Type for the renderCall args parameter (subset of DelegateParams) */
export interface DelegateToolArgs {
  tasks?: Array<{ name?: string; prompt?: string; profile?: string }>;
  profile?: string;
}

/**
 * Render the delegate_to_subagents tool call display.
 */
export function renderDelegateCall(
  args: DelegateToolArgs,
  theme: Theme,
  _context: unknown,
): InstanceType<typeof Text> {
  const count = args.tasks?.length ?? 1;
  const taskProfiles = (args.tasks ?? []).map((t) => t.profile).filter(Boolean) as string[];
  const defaultProfile = args.profile;

  let text =
    theme.fg("toolTitle", theme.bold("delegate_to_subagents ")) +
    theme.fg("accent", `${count} sub-agent${count > 1 ? "s" : ""}`);

  if (defaultProfile) {
    text += theme.fg("dim", ` (default profile: ${defaultProfile})`);
  }
  if (taskProfiles.length > 0) {
    text += theme.fg("dim", ` profiles: [${taskProfiles.join(", ")}]`);
  }
  return new Text(text, 0, 0);
}

// ── Delegate tool result rendering ──────────────────────────────────────────

/** Build the global status header line showing running/done/error counts. */
function buildStatusHeader(running: number, done: number, errors: number, theme: Theme): string {
  let header = theme.fg("toolTitle", theme.bold("Sub-agents: "));
  const parts: string[] = [];
  if (running > 0) {
    parts.push(theme.fg("warning", `${running} running`));
  }
  if (done > 0) {
    parts.push(theme.fg("success", `${done} done`));
  }
  if (errors > 0) {
    parts.push(theme.fg("error", `${errors} error${errors > 1 ? "s" : ""}`));
  }
  header += parts.join(theme.fg("dim", ", "));
  return header;
}

/** Build the per-agent header line with profile, tool count, file count, todos, and elapsed time. */
function buildWindowHeader(win: SubAgentWindow, theme: Theme): string {
  const icon = win.status === "running" ? "⏳" : win.status === "error" ? "✗" : "✓";
  const color = win.status === "running" ? "warning" : win.status === "error" ? "error" : "success";

  let headerLine = `${theme.fg(color, icon)} ${theme.fg("accent", theme.bold(win.name))}`;

  const headerParts: string[] = [];
  if (win.profileName) {
    headerParts.push(buildProfileSegment(win));
  }
  headerParts.push(`${win.toolCount} tools`);
  if (win.fileCount > 0) {
    headerParts.push(`${win.fileCount} files`);
  }
  if (win.todoTotal !== undefined && win.todoTotal > 0 && win.todoCompleted !== win.todoTotal) {
    headerParts.push(`[${win.todoCompleted ?? 0}/${win.todoTotal}]`);
  }
  const endTime = win.completedAt ?? Date.now();
  const elapsed = Math.floor((endTime - win.startedAt) / 1000);
  headerParts.push(`${elapsed}s/${win.timeout}s`);

  headerLine += theme.fg("dim", ` • ${headerParts.join(" • ")}`);
  return headerLine;
}

/** Build the profile info segment for a window header. */
function buildProfileSegment(win: SubAgentWindow): string {
  let profilePart = win.profileName ?? "";
  const provModel = [win.provider, win.model].filter(Boolean).join("/");
  if (provModel) {
    profilePart += ` (${provModel}`;
  }
  if (win.thinkingLevel) {
    profilePart += provModel ? ` ${win.thinkingLevel}` : ` (${win.thinkingLevel})`;
  }
  if (provModel) {
    profilePart += ")";
  }
  return profilePart;
}

/** Add window message lines (expanded or collapsed) to the container. */
function addWindowMessages(
  container: Container,
  win: SubAgentWindow,
  expanded: boolean,
  theme: Theme,
): void {
  const renderLine = (entry: WindowLine) => {
    if (entry.kind === "tool") {
      container.addChild(new Text(`  ${colorizeToolLine(entry.text, theme)}`, 0, 0));
    } else {
      for (const line of entry.text.split("\n")) {
        container.addChild(new Text(`  ${line}`, 0, 0));
      }
    }
  };

  if (expanded) {
    if (win.allMessages.length === 0) {
      container.addChild(new Text(theme.fg("muted", "  (no output)"), 0, 0));
    } else {
      for (const entry of win.allMessages) {
        renderLine(entry);
      }
    }
  } else {
    if (win.lines.length === 0) {
      container.addChild(new Text(theme.fg("muted", "  (starting...)"), 0, 0));
    } else {
      for (const entry of win.lines) {
        renderLine(entry);
      }
    }
  }
}

/** Add the footer section (running indicator or session IDs) to the container. */
function addFooter(
  container: Container,
  running: number,
  windows: SubAgentWindow[],
  theme: Theme,
): void {
  if (running > 0) {
    container.addChild(new Text(theme.fg("muted", `${running} running...`), 0, 0));
    return;
  }
  const idLines = windows.map((w) => `  ${w.name}: ${theme.fg("accent", w.sessionId)}`);
  container.addChild(
    new Text(theme.fg("dim", "Session IDs (use with get_subagent_output):"), 0, 0),
  );
  for (const line of idLines) {
    container.addChild(new Text(`  ${line}`, 0, 0));
  }
}

/**
 * Render the delegate_to_subagents tool result display (live rolling window).
 */
export function renderDelegateResult(
  result: AgentToolResult<WindowedSubagentDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: unknown,
): Container | Text {
  const details = result.details;
  if (!details) {
    return new Text("(no sub-agent details)", 0, 0);
  }

  const container = new Container();
  const { running, completed: done, error: errors } = countWindowStatuses(details.windows);

  // ── Global status header ──
  container.addChild(new Text(buildStatusHeader(running, done, errors, theme), 0, 0));
  container.addChild(new Spacer(1));

  // ── Per-agent windows ──
  for (const win of details.windows) {
    container.addChild(new Text(buildWindowHeader(win, theme), 0, 0));
    addWindowMessages(container, win, options.expanded, theme);
    if (win.status === "error" && win.errorMessage) {
      container.addChild(new Text(theme.fg("error", `  Error: ${win.errorMessage}`), 0, 0));
    }
    container.addChild(new Spacer(1));
  }

  // ── Footer ──
  addFooter(container, running, details.windows, theme);

  return container;
}
