/**
 * Bash Command Formatting
 *
 * Functions for collapsing cd prefixes and formatting bash commands
 * with smart && splitting for display.
 */

const TRUNCATION_SUFFIX_LENGTH = 3;
const BASH_PREFIX_WIDTH = 12;
const BASH_CONT_PREFIX_WIDTH = 5;

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
    _cdPattern = new RegExp(`^cd\\s+${escapedCwd}(\\s*(?:&&|;)\\s*(.*))?$`);
  }
  return _cdPattern as RegExp;
}

export function collapseCdDot(command: string, cwd: string): string {
  const match = command.match(getCdPattern(cwd));

  if (!match) {
    return command;
  }

  if (!command.includes("&&") && !command.includes(";")) {
    // Exact match: `cd <cwd>` with nothing after → return "."
    return ".";
  }

  // Has a separator (&& or ;) — match[2] is the text after it, which may be empty
  const after = match[2];
  if (!after || after.trim() === "") {
    // `cd <cwd> &&` with nothing after → return empty string
    return "";
  }

  // `cd <cwd> && ...` → strip prefix, return the rest
  return after.trimStart();
}

// ── Bash Command Formatting ────────────────────────────────────────

function flushTruncatedSegment(
  seg: string,
  budget: number,
  isLast: boolean,
  isFirstLine: boolean,
  lines: string[],
  contPrefix: string,
  suffixSep: string,
): { isFirstLine: boolean } {
  const truncated = `${seg.slice(0, budget - TRUNCATION_SUFFIX_LENGTH)}...`;
  const prefix = isFirstLine ? "" : contPrefix;
  const suffix = isLast ? "" : suffixSep;
  lines.push(`${prefix}${truncated}${suffix}`);
  return { isFirstLine: false };
}

function formatBashSegments(
  segments: string[],
  separators: string[],
  firstLineBudget: number,
  contLineBudget: number,
  contPrefix: string,
): string {
  const lines: string[] = [];
  let currentLine = "";
  let isFirstLine = true;

  for (let i = 0; i < segments.length; i++) {
    const budget = isFirstLine && currentLine.length === 0 ? firstLineBudget : contLineBudget;
    const seg = segments[i];
    if (!seg) continue;
    const isLast = i === segments.length - 1;
    const nextSep = !isLast && i < separators.length ? ` ${separators[i]!}` : "";

    if (currentLine.length === 0) {
      if (seg.length <= budget) {
        currentLine = `${isFirstLine ? "" : contPrefix}${seg}`;
      } else {
        const result = flushTruncatedSegment(seg, budget, isLast, isFirstLine, lines, contPrefix, nextSep);
        isFirstLine = result.isFirstLine;
        currentLine = "";
      }
    } else {
      // Separator between the last segment on the current line (i-1) and this segment (i)
      const sep = i > 0 && i - 1 < separators.length ? ` ${separators[i - 1]!} ` : " && ";
      const withSeg = `${currentLine}${sep}${seg}`;
      if (withSeg.length <= budget) {
        currentLine = withSeg;
      } else {
        // Line-end separator between the last segment on this line and the first on the next
        const lineEndSep = i > 0 && i - 1 < separators.length ? ` ${separators[i - 1]!}` : " &&";
        lines.push(`${currentLine}${lineEndSep}`);
        isFirstLine = false;

        if (seg.length <= contLineBudget) {
          currentLine = `${contPrefix}${seg}`;
        } else {
          const result = flushTruncatedSegment(
            seg,
            contLineBudget,
            isLast,
            false,
            lines,
            contPrefix,
            nextSep,
          );
          isFirstLine = result.isFirstLine;
          currentLine = "";
        }
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.join("\n");
}

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

  // Split on && or ; while tracking which separator was used
  const parts = cmd.split(/\s*(&&|;)\s*/);
  // parts alternates: [segment, separator, segment, separator, segment, ...]
  const segments: string[] = [];
  const separators: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 0) {
      segments.push(part);
    } else {
      separators.push(part);
    }
  }

  if (cmd.length <= firstLineBudget) {
    // Rejoin with original separators, preserving their type
    if (segments.length > 1) {
      let result = segments[0]!;
      for (let i = 0; i < separators.length; i++) {
        result += ` ${separators[i]!} ${segments[i + 1]!}`;
      }
      return result;
    }
    return cmd;
  }

  if (segments.length === 1) {
    // Single segment, just truncate
    return `${cmd.slice(0, firstLineBudget - TRUNCATION_SUFFIX_LENGTH)}...`;
  }

  const contPrefix = "\u2502 "; // \u2502 = │ prefix for continuation lines

  return formatBashSegments(segments, separators, firstLineBudget, contLineBudget, contPrefix);
}

export { BASH_CONT_PREFIX_WIDTH, BASH_PREFIX_WIDTH };
