/**
 * Path Shortening Utilities
 *
 * Functions for shortening absolute file paths relative to a cwd,
 * and replacing paths in arbitrary text with shortened versions.
 */

import { homedir } from "node:os";
import { relative, sep } from "node:path";

const HOME = homedir();

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
  if (absolutePath.startsWith(`${HOME}${sep}`)) {
    const rest = absolutePath.slice(HOME.length + 1);
    displayPath = `~/${rest.replace(/\\/g, "/")}`;
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

/** Pattern for matching absolute paths (at least 2 segments, starting with /) */
export const ABSOLUTE_PATH_PATTERN =
  "(?:^|[^:\\w/\\\\])((?:\\/[a-zA-Z0-9._-]+){2,}|[A-Za-z]:[\\\\/][a-zA-Z0-9._ -]+(?:[\\\\/][a-zA-Z0-9._ -]+)+)";

/**
 * Finds absolute paths in arbitrary text and shortens them.
 * Excludes URLs (preceded by `://`).
 */
export function shortenPathsInText(text: string, cwd: string): string {
  const matches: Array<{ match: string; index: number }> = [];
  const regex = new RegExp(ABSOLUTE_PATH_PATTERN, "g");
  let m: RegExpExecArray | null = regex.exec(text);
  while (m !== null) {
    if (m[1]) {
      matches.push({ match: m[1], index: m.index + (m[0].length - m[1].length) });
    }
    m = regex.exec(text);
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
