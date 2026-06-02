/**
 * File reading utilities for the delegate tool.
 *
 * Handles reading files and slicing lines for injection into sub-agent prompts.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FileSpec } from "../types";

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum file size allowed for reading (1 MB) */
export const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB

// ── File Reading ──────────────────────────────────────────────────────

/**
 * Apply line slicing to file contents based on a FileSpec.
 * Returns the sliced lines as-is if the spec is a plain string path.
 */
export function sliceLines(lines: string[], spec: FileSpec): string[] {
  if (typeof spec === "string") return lines;
  if ("tail" in spec) return spec.tail > 0 ? lines.slice(-spec.tail) : [];
  if ("head" in spec) return spec.head > 0 ? lines.slice(0, spec.head) : [];
  return lines.slice((spec.start ?? 1) - 1, spec.end ?? lines.length);
}

/**
 * Read a file and return its formatted contents for prompt injection.
 * Returns `[file not found: <path>]` if the file doesn't exist or can't be read.
 * Line numbers are 1-indexed and inclusive.
 */
export async function readFileContents(spec: FileSpec, cwd: string): Promise<string> {
  const path = typeof spec === "string" ? spec : spec.path;
  const absolutePath = resolve(cwd, path);

  // Prevent path traversal outside cwd
  const resolvedCwd = resolve(cwd);
  if (absolutePath !== resolvedCwd && !absolutePath.startsWith(resolvedCwd + sep)) {
    return `[access denied: path outside project directory: ${path}]`;
  }

  // Check file size before reading
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return `[file too large: ${path} (${Math.round(fileStat.size / 1024)}KB, limit ${MAX_FILE_BYTES / 1024}KB)]`;
    }
  } catch {
    return `[file not found: ${path}]`;
  }

  let contents: string;
  try {
    contents = await readFile(absolutePath, "utf-8");
  } catch {
    return `[could not read file: ${path}]`;
  }

  let lines = contents.split("\n");

  // Strip trailing empty line from newline-terminated files (before slicing)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  lines = sliceLines(lines, spec);

  return `=== ${path} ===\n${lines.join("\n")}`;
}
