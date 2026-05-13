/**
 * Subagent Profile System
 *
 * Loads named profiles from pi settings files (global + project-local)
 * and resolves them into CLI arguments for sub-agent processes.
 *
 * Profile configuration in settings.json:
 * {
 *   "subagents": {
 *     "profiles": {
 *       "code-reviewer": {
 *         "model": "anthropic/claude-sonnet-4-5",
 *         "systemPrompt": "You are a code reviewer. Focus on...",
 *         "thinkingLevel": "high",
 *         "tools": ["read", "bash", "grep"]
 *       },
 *       "fast-worker": {
 *         "model": "dashscope/qwen3.5-plus",
 *         "appendSystemPrompt": "Be concise. Skip explanations.",
 *         "thinkingLevel": "off"
 *       },
 *       "researcher": {
 *         "provider": "openai",
 *         "model": "gpt-4o",
 *         "systemPrompt": "You are a research assistant...",
 *         "thinkingLevel": "medium",
 *         "noExtensions": true
 *       }
 *     }
 *   }
 * }
 */

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Profile Types ────────────────────────────────────────────────────

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SubagentProfile {
  /** Provider name (e.g. "anthropic", "openai", "dashscope") */
  provider?: string;

  /** Model pattern or ID (supports "provider/id" and ":thinking" shorthand) */
  model?: string;

  /** Replace the default system prompt entirely */
  systemPrompt?: string;

  /** Append text to the default system prompt */
  appendSystemPrompt?: string;

  /** Explicit thinking level: off, minimal, low, medium, high, xhigh */
  thinkingLevel?: ThinkingLevel;

  /** Disable all tools */
  noTools?: boolean;

  /** Comma-separated allowlist of tool names to enable */
  tools?: string[];

  /** Disable all extensions */
  noExtensions?: boolean;

  /** Extension paths to load (can be used multiple times) */
  extensions?: string[];

  /** Disable skills */
  noSkills?: boolean;

  /** Disable context files (AGENTS.md, CLAUDE.md) */
  noContextFiles?: boolean;

  /** Custom API key */
  apiKey?: string;

  /** Additional CLI arguments to pass verbatim */
  extraArgs?: string[];
}

export interface SubagentProfiles {
  [name: string]: SubagentProfile;
}

/**
 * Result of converting a profile to invocation parameters.
 * Contains both CLI arguments and environment variables.
 */
export interface ProfileInvocation {
  args: string[];
  env: Record<string, string>;
}

interface SubagentSettings {
  profiles?: SubagentProfiles;
  agentOverrides?: Record<string, Partial<SubagentProfile>>;
  maxLinesPerWindow?: number;
  [key: string]: unknown;
}

/** Raw settings file structure with unknown properties */
interface SettingsFile {
  subagents?: SubagentSettings;
  [key: string]: unknown;
}

// ── Profile Cache ─────────────────────────────────────────────────────

let profilesCache: { cwd: string | undefined; profiles: SubagentProfiles; timestamp: number } | null = null;
const CACHE_TTL = 5000; // 5 seconds

export function invalidateProfilesCache(): void {
  profilesCache = null;
}

// ── Settings Loading ─────────────────────────────────────────────────

function getGlobalSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

async function readSettingsFile(filePath: string): Promise<SettingsFile> {
  if (!existsSync(filePath)) return {};
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Failed to read settings file ${filePath}:`, error instanceof Error ? error.message : error);
    return {};
  }
}

/**
 * Load subagent profiles from settings files.
 * Project-local settings override global settings.
 */
export async function loadProfiles(cwd?: string): Promise<SubagentProfiles> {
  const now = Date.now();
  if (profilesCache && profilesCache.cwd === cwd && now - profilesCache.timestamp < CACHE_TTL) {
    return profilesCache.profiles;
  }

  const globalSettings = await readSettingsFile(getGlobalSettingsPath());
  const globalSubagents: SubagentSettings = globalSettings.subagents ?? {};

  let profiles: SubagentProfiles = { ...globalSubagents.profiles };

  // Merge agentOverrides as simple profiles (backward compat)
  if (globalSubagents.agentOverrides) {
    for (const [name, override] of Object.entries(globalSubagents.agentOverrides)) {
      if (!profiles[name]) {
        profiles[name] = override;
      }
    }
  }

  // Merge project-local settings on top
  if (cwd) {
    const projectSettings = await readSettingsFile(getProjectSettingsPath(cwd));
    const projectSubagents: SubagentSettings = projectSettings.subagents ?? {};

    if (projectSubagents.profiles) {
      profiles = { ...profiles, ...projectSubagents.profiles };
    }

    if (projectSubagents.agentOverrides) {
      for (const [name, override] of Object.entries(projectSubagents.agentOverrides)) {
        if (!profiles[name]) {
          profiles[name] = override;
        }
      }
    }
  }

  profilesCache = { cwd, profiles, timestamp: now };
  return profiles;
}

/**
 * Resolve a profile name to a SubagentProfile, falling back to
 * agentOverrides for backward compatibility.
 */
export function resolveProfile(profiles: SubagentProfiles, profileName: string): SubagentProfile | undefined {
  // Intentional abstraction point for future backward-compatibility resolution
  return profiles[profileName];
}

// ── CLI Argument Building ────────────────────────────────────────────

/**
 * Convert a SubagentProfile into invocation parameters for the pi subprocess.
 * Returns both CLI arguments and environment variables.
 */
export function profileToArgs(profile: SubagentProfile): ProfileInvocation {
  const args: string[] = [];
  const envVars: Record<string, string> = {};

  if (profile.provider) {
    args.push("--provider", profile.provider);
  }

  if (profile.model) {
    // Support "provider/id" and ":thinking" shorthand in the model field
    args.push("--model", profile.model);
  }

  if (profile.systemPrompt) {
    args.push("--system-prompt", profile.systemPrompt);
  }

  if (profile.appendSystemPrompt) {
    args.push("--append-system-prompt", profile.appendSystemPrompt);
  }

  if (profile.thinkingLevel) {
    args.push("--thinking", profile.thinkingLevel);
  }

  // Store API key in environment variable to avoid CLI exposure via /proc/PID/cmdline
  if (profile.apiKey) {
    envVars.PI_API_KEY = profile.apiKey;
  }

  if (profile.noTools) {
    args.push("--no-tools");
  } else if (profile.tools && profile.tools.length > 0) {
    args.push("--tools", profile.tools.join(","));
  }

  if (profile.noExtensions) {
    args.push("--no-extensions");
  }

  if (profile.extensions) {
    for (const ext of profile.extensions) {
      args.push("--extension", ext);
    }
  }

  if (profile.noSkills) {
    args.push("--no-skills");
  }

  if (profile.noContextFiles) {
    args.push("--no-context-files");
  }

  // Validate extraArgs for safety before pushing
  if (profile.extraArgs) {
    for (const arg of profile.extraArgs) {
      // Block null bytes
      if (arg.includes("\0")) {
        throw new Error("Invalid extraArg: contains null byte");
      }
      // Block shell operators and command separators
      if (/^[\s|&;$\\`!]|&&|\|\||;|>|>>|<|<</.test(arg)) {
        throw new Error(`Refusing extraArg: potentially unsafe argument '${arg.slice(0, 40)}'`);
      }
    }
    args.push(...profile.extraArgs);
  }

  return { args, env: envVars };
}

/**
 * Get a human-readable summary of a profile for display in the TUI.
 */
export function profileSummary(name: string, profile: SubagentProfile): string {
  const parts: string[] = [`profile: ${name}`];
  if (profile.model) parts.push(`model=${profile.model}`);
  else if (profile.provider) parts.push(`provider=${profile.provider}`);
  if (profile.thinkingLevel) parts.push(`thinking=${profile.thinkingLevel}`);
  if (profile.systemPrompt) parts.push("custom-system-prompt");
  if (profile.appendSystemPrompt) parts.push("appended-system-prompt");
  if (profile.noTools) parts.push("no-tools");
  else if (profile.tools) parts.push(`tools=[${profile.tools.join(",")}]`);
  return parts.join(", ");
}

// ── Profile Mutation ─────────────────────────────────────────────────

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

export type ProfileScope = "global" | "project";

/**
 * Read the raw settings file, apply a mutator, and write it back.
 * The mutator receives the subagents section and returns true if changed.
 */
async function mutateSettingsFile(filePath: string, mutator: (subagents: SubagentSettings) => boolean): Promise<void> {
  let settings: SettingsFile = {};
  if (existsSync(filePath)) {
    try {
      settings = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.subagents) settings.subagents = {};

  const changed = mutator(settings.subagents);
  if (!changed) return;

  invalidateProfilesCache();

  // Clean up empty sub-objects
  if (settings.subagents.profiles && Object.keys(settings.subagents.profiles).length === 0) {
    delete settings.subagents.profiles;
  }
  if (settings.subagents.agentOverrides && Object.keys(settings.subagents.agentOverrides).length === 0) {
    delete settings.subagents.agentOverrides;
  }
  if (Object.keys(settings.subagents).length === 0) {
    delete settings.subagents;
  }

  await atomicWriteFile(filePath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function getSettingsPath(scope: ProfileScope, cwd?: string): string {
  if (scope === "project") {
    return getProjectSettingsPath(cwd ?? process.cwd());
  }
  return getGlobalSettingsPath();
}

/**
 * Save (create or update) a profile to the given scope.
 */
export async function saveProfile(
  name: string,
  profile: SubagentProfile,
  scope: ProfileScope,
  cwd?: string,
): Promise<void> {
  const filePath = getSettingsPath(scope, cwd);
  await mutateSettingsFile(filePath, (subagents) => {
    if (!subagents.profiles) subagents.profiles = {};
    subagents.profiles[name] = profile;
    return true;
  });
  invalidateProfilesCache();
}

/**
 * Delete a profile from the given scope.
 * Checks both subagents.profiles and subagents.agentOverrides.
 * Returns true if the profile existed and was deleted.
 */
export async function deleteProfile(name: string, scope: ProfileScope, cwd?: string): Promise<boolean> {
  const filePath = getSettingsPath(scope, cwd);
  let existed = false;
  await mutateSettingsFile(filePath, (subagents) => {
    // Check profiles first
    if (subagents.profiles?.[name]) {
      existed = true;
      delete subagents.profiles[name];
    }
    // Also check agentOverrides (backward compat)
    if (subagents.agentOverrides?.[name]) {
      existed = true;
      delete subagents.agentOverrides[name];
    }
    return existed;
  });
  if (existed) {
    invalidateProfilesCache();
  }
  return existed;
}

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
 * Format a profile as a human-readable multi-line string for display.
 */
export function formatProfileDetail(name: string, profile: SubagentProfile): string {
  const lines: string[] = [];
  lines.push(`Profile: ${name}`);
  if (profile.provider) lines.push(`  provider:          ${profile.provider}`);
  if (profile.model) lines.push(`  model:             ${profile.model}`);
  if (profile.thinkingLevel) lines.push(`  thinkingLevel:     ${profile.thinkingLevel}`);
  if (profile.systemPrompt) lines.push(`  systemPrompt:      ${profile.systemPrompt}`);
  if (profile.appendSystemPrompt) lines.push(`  appendSystemPrompt: ${profile.appendSystemPrompt}`);
  if (profile.noTools) lines.push(`  noTools:           true`);
  else if (profile.tools) lines.push(`  tools:             [${profile.tools.join(", ")}]`);
  if (profile.noExtensions) lines.push(`  noExtensions:      true`);
  if (profile.extensions) lines.push(`  extensions:        [${profile.extensions.join(", ")}]`);
  if (profile.noSkills) lines.push(`  noSkills:          true`);
  if (profile.noContextFiles) lines.push(`  noContextFiles:    true`);
  if (profile.apiKey) {
    const masked = profile.apiKey.length > 8 ? `${profile.apiKey.slice(0, 4)}****${profile.apiKey.slice(-4)}` : "****";
    lines.push(`  apiKey:            ${masked}`);
  }
  if (profile.extraArgs) lines.push(`  extraArgs:         ${JSON.stringify(profile.extraArgs)}`);
  return lines.join("\n");
}
