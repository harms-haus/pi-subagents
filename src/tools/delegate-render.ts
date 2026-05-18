/**
 * Delegate Rendering Functions
 *
 * Pure rendering functions for the delegate_to_subagents tool,
 * extracted for testability and reuse.
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { countWindowStatuses } from "../utils";
import type { WindowedSubagentDetails, WindowLine } from "../types";
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

/**
 * Apply theme colors to specific patterns in tool call lines.
 * Colorizes diff stats (+N/-M) and line counts (N lines) while keeping
 * the rest of the line in muted color.
 */
export function colorizeToolLine(line: string, theme: Theme): string {
  // Pattern 1: +N/-M diff stats (edit tool)
  const diffMatch = line.match(/^(.*?)(\+\d+\/-\d+)(.*)$/);
  if (diffMatch) {
    const [, prefix, stats, suffix] = diffMatch;
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

  // Pattern 2: +N at end (write tool, no removal count)
  if (line.includes("write")) {
    const writeMatch = line.match(/^(.*?)(\+\d+)(\s*)$/);
    if (writeMatch) {
      const [, prefix, added, trailing] = writeMatch;
      return theme.fg("muted", prefix) + theme.fg("toolDiffAdded", added) + trailing;
    }
  }

  // Pattern 3: (N lines) line count (read tool)
  const readMatch = line.match(/^(.*?)(\()(\d+)( lines?\))(.*)$/);
  if (readMatch) {
    const [, prefix, openParen, count, closePart, suffix] = readMatch;
    return (
      theme.fg("muted", prefix) +
      theme.fg("muted", openParen) +
      theme.fg("toolDiffAdded", count) +
      theme.fg("muted", closePart) +
      theme.fg("muted", suffix)
    );
  }

  // Default: muted
  return theme.fg("muted", line);
}

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
  {
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
    container.addChild(new Text(header, 0, 0));
    container.addChild(new Spacer(1));
  }

  // ── Per-agent windows ──
  const renderLine = (entry: WindowLine) => {
    if (entry.kind === "tool") {
      container.addChild(new Text(`  ${colorizeToolLine(entry.text, theme)}`, 0, 0));
    } else {
      const lines = entry.text.split("\n");
      for (const line of lines) {
        container.addChild(new Text(`  ${line}`, 0, 0));
      }
    }
  };

  for (const win of details.windows) {
    const icon = win.status === "running" ? "⏳" : win.status === "error" ? "✗" : "✓";
    const color =
      win.status === "running" ? "warning" : win.status === "error" ? "error" : "success";

    let headerLine = `${theme.fg(color, icon)} ${theme.fg("accent", theme.bold(win.name))}`;

    // Profile info segment
    const headerParts: string[] = [];
    if (win.profileName) {
      let profilePart = win.profileName;
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
      headerParts.push(profilePart);
    }

    // Tool count
    headerParts.push(`${win.toolCount} tools`);

    // Todo segment - only show if todos are active and not all complete
    if (win.todoTotal !== undefined && win.todoTotal > 0 && win.todoCompleted !== win.todoTotal) {
      headerParts.push(`[${win.todoCompleted ?? 0}/${win.todoTotal}]`);
    }

    // Time segment
    const endTime = win.completedAt ?? Date.now();
    const elapsed = Math.floor((endTime - win.startedAt) / 1000);
    headerParts.push(`${elapsed}s/${win.timeout}s`);

    headerLine += theme.fg("dim", ` • ${headerParts.join(" • ")}`);
    container.addChild(new Text(headerLine, 0, 0));

    if (options.expanded) {
      // Expanded (Ctrl+O): show all captured messages, not just latest N
      if (win.allMessages.length === 0) {
        container.addChild(new Text(theme.fg("muted", "  (no output)"), 0, 0));
      } else {
        for (const entry of win.allMessages) {
          renderLine(entry);
        }
      }
    } else {
      // Collapsed: rolling window (latest N lines)
      if (win.lines.length === 0) {
        container.addChild(new Text(theme.fg("muted", "  (starting...)"), 0, 0));
      } else {
        for (const entry of win.lines) {
          renderLine(entry);
        }
      }
    }

    if (win.status === "error" && win.errorMessage) {
      container.addChild(new Text(theme.fg("error", `  Error: ${win.errorMessage}`), 0, 0));
    }

    container.addChild(new Spacer(1));
  }

  // ── Footer: session IDs when done ──
  if (running > 0) {
    container.addChild(new Text(theme.fg("muted", `${running} running...`), 0, 0));
  } else {
    // Show session IDs for retrieval
    const idLines = details.windows.map((w) => `  ${w.name}: ${theme.fg("accent", w.sessionId)}`);
    container.addChild(
      new Text(theme.fg("dim", "Session IDs (use with get_subagent_output):"), 0, 0),
    );
    for (const line of idLines) {
      container.addChild(new Text(`  ${line}`, 0, 0));
    }
  }

  return container;
}
