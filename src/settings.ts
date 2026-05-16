/**
 * Subagent Settings
 *
 * Reads maxLinesPerWindow and commandPreviewWidth from global and project-local
 * settings files. Project-local settings override global settings.
 *
 * Settings file locations:
 *   Global:   ~/.pi/agent/settings.json
 *   Project:  .pi/settings.json
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Settings Types ───────────────────────────────────────────────────

export interface SubagentSettings {
  maxLinesPerWindow?: number;
  commandPreviewWidth?: number;
  [key: string]: unknown;
}

export interface SettingsFile {
  subagents?: SubagentSettings;
  [key: string]: unknown;
}

// ── Settings File Paths ──────────────────────────────────────────────

export function getGlobalSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

// ── Settings File Reading ────────────────────────────────────────────

export async function readSettingsFile(filePath: string): Promise<SettingsFile> {
  if (!existsSync(filePath)) {return {};}
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Failed to read settings file ${filePath}:`, error instanceof Error ? error.message : error);
    return {};
  }
}

// ── Exported Settings Loaders ────────────────────────────────────────

/**
 * Load maxLinesPerWindow from settings files.
 * Project-local settings override global settings. Defaults to 15.
 */
export async function loadMaxLinesPerWindow(cwd?: string): Promise<number> {
  const globalSettings = await readSettingsFile(getGlobalSettingsPath());
  const globalSubagents: SubagentSettings = globalSettings.subagents ?? {};
  let maxLines = globalSubagents.maxLinesPerWindow ?? 15;

  if (cwd) {
    const projectSettings = await readSettingsFile(getProjectSettingsPath(cwd));
    const projectSubagents: SubagentSettings = projectSettings.subagents ?? {};
    if (projectSubagents.maxLinesPerWindow !== undefined) {
      maxLines = projectSubagents.maxLinesPerWindow;
    }
  }

  return maxLines;
}

/**
 * Load commandPreviewWidth from the terminal or settings files.
 *
 * If stdout is a TTY (process.stdout.columns is a number), returns
 * columns - 4 (accounting for 2-char indent + "→ " prefix).
 * Otherwise falls back to settings files (project overrides global),
 * defaulting to 160 if no setting is found.
 * Result is clamped to a minimum of 20.
 */
export async function loadCommandPreviewWidth(cwd?: string): Promise<number> {
  // If we have a real terminal, use its width
  if (typeof process.stdout.columns === "number") {
    return Math.max(process.stdout.columns - 4, 20);
  }

  // Non-TTY: read from settings files
  const globalSettings = await readSettingsFile(getGlobalSettingsPath());
  const globalSubagents: SubagentSettings = globalSettings.subagents ?? {};
  let width = globalSubagents.commandPreviewWidth ?? 160;

  if (cwd) {
    const projectSettings = await readSettingsFile(getProjectSettingsPath(cwd));
    const projectSubagents: SubagentSettings = projectSettings.subagents ?? {};
    if (projectSubagents.commandPreviewWidth !== undefined) {
      width = projectSubagents.commandPreviewWidth;
    }
  }

  return Math.max(width, 20);
}
