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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Settings Types ───────────────────────────────────────────────────

export interface SubagentSettings {
  maxLinesPerWindow?: number;
  commandPreviewWidth?: number;
  extend_timeout_debounce?: number;
  looping_tool_count?: number;
  [key: string]: unknown;
}

export interface SettingsFile {
  subagents?: SubagentSettings;
  [key: string]: unknown;
}

// ── Settings File Paths ──────────────────────────────────────────────

export function getGlobalSettingsPath(): string {
  const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

// ── Settings File Reading ────────────────────────────────────────────

export async function readSettingsFile(filePath: string): Promise<SettingsFile> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as SettingsFile;
  } catch (error) {
    const isEnoent =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!isEnoent) {
      console.warn(
        `Failed to read settings file ${filePath}:`,
        error instanceof Error ? error.message : error,
      );
    }
    return {};
  }
}

// ── Private Settings Helper ─────────────────────────────────────────

async function loadSetting(
  key: string,
  defaultValue: number,
  cwd?: string,
  options?: { clamp?: [number, number] },
): Promise<number> {
  const globalSettings = await readSettingsFile(getGlobalSettingsPath());
  const globalSubagents = globalSettings.subagents ?? {};
  let value: unknown = (globalSubagents as Record<string, unknown>)[key] ?? defaultValue;

  if (cwd) {
    const projectSettings = await readSettingsFile(getProjectSettingsPath(cwd));
    const projectSubagents = projectSettings.subagents ?? {};
    const projectValue = (projectSubagents as Record<string, unknown>)[key];
    if (projectValue !== undefined) {
      value = projectValue;
    }
  }

  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  if (options?.clamp) {
    return Math.max(options.clamp[0], Math.min(options.clamp[1], value));
  }
  return value;
}

// ── Exported Settings Loaders ────────────────────────────────────────

/**
 * Load maxLinesPerWindow from settings files.
 * Project-local settings override global settings. Defaults to 15.
 */
export async function loadMaxLinesPerWindow(cwd?: string): Promise<number> {
  return loadSetting("maxLinesPerWindow", 15, cwd);
}

/**
 * Load commandPreviewWidth from settings files, with TTY fallback.
 *
 * Priority order:
 *   1. Explicitly configured setting (project overrides global)
 *   2. TTY-derived width: Math.max(process.stdout.columns - 4, 20)
 *   3. Default: 160
 * Result is clamped to a minimum of 20.
 */
export async function loadCommandPreviewWidth(cwd?: string): Promise<number> {
  // Read settings files to check for an explicitly configured value
  const globalSettings = await readSettingsFile(getGlobalSettingsPath());
  const globalSubagents = globalSettings.subagents ?? {};
  let configuredValue: unknown = (globalSubagents as Record<string, unknown>)[
    "commandPreviewWidth"
  ];

  if (cwd) {
    const projectSettings = await readSettingsFile(getProjectSettingsPath(cwd));
    const projectSubagents = projectSettings.subagents ?? {};
    const projectValue = (projectSubagents as Record<string, unknown>)["commandPreviewWidth"];
    if (projectValue !== undefined) {
      configuredValue = projectValue;
    }
  }

  // If the user explicitly configured a value, use it (clamped)
  if (typeof configuredValue === "number" && Number.isFinite(configuredValue)) {
    return Math.max(configuredValue, 20);
  }

  // No explicit setting: fall back to TTY width if available
  if (typeof process.stdout.columns === "number") {
    return Math.max(process.stdout.columns - 4, 20);
  }

  // No TTY and no setting: use default
  return 160;
}

/**
 * Load extend_timeout_debounce from settings files.
 * Project-local settings override global settings. Defaults to 30.
 */
export async function loadExtendTimeoutDebounce(cwd?: string): Promise<number> {
  return loadSetting("extend_timeout_debounce", 30, cwd, { clamp: [0, 300] });
}

/**
 * Load looping_tool_count from settings files.
 * Project-local settings override global settings. Defaults to 5.
 */
export async function loadLoopingToolCount(cwd?: string): Promise<number> {
  return loadSetting("looping_tool_count", 5, cwd, { clamp: [0, 50] });
}
