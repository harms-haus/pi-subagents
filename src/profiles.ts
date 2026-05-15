/**
 * Subagent Profile System
 *
 * Loads named profiles from individual markdown files with YAML frontmatter,
 * and resolves them into CLI arguments for sub-agent processes.
 *
 * Profile locations:
 *   Global:   ~/.pi/agent/agent-profiles/*.md
 *   Project:  .pi/agent-profiles/*.md
 *
 * Project-local profiles override global profiles with the same name.
 *
 * Profile markdown format:
 * ---
 * name: my-profile
 * provider: anthropic
 * model: claude-sonnet-4-5
 * thinkingLevel: high
 * tools: read,bash,grep
 * ---
 *
 * You are a coding agent...
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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

  /** Blacklist of tool names to exclude from the full set */
  excludeTools?: string[];

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

// ── Profile Cache ─────────────────────────────────────────────────────

let profilesCache: { cwd: string | undefined; profiles: SubagentProfiles; timestamp: number } | null = null;
const CACHE_TTL = 5000; // 5 seconds

export function invalidateProfilesCache(): void {
  profilesCache = null;
}

// ── Helpers for array/string frontmatter fields ──────────────────────

function parseStringOrArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

// ── Profile Directory Paths ──────────────────────────────────────────

function getGlobalProfilesDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "agent-profiles");
}

function getProjectProfilesDir(cwd: string): string {
  return join(cwd, ".pi", "agent-profiles");
}

export type ProfileScope = "global" | "project";

export function getProfilesDir(scope: ProfileScope, cwd?: string): string {
  return scope === "project" ? getProjectProfilesDir(cwd ?? process.cwd()) : getGlobalProfilesDir();
}

// ── Settings File Reading (for loadMaxLinesPerWindow only) ───────────

interface SubagentSettings {
  maxLinesPerWindow?: number;
  commandPreviewWidth?: number;
  [key: string]: unknown;
}

interface SettingsFile {
  subagents?: SubagentSettings;
  [key: string]: unknown;
}

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

// ── Profile Tool Validation ───────────────────────────────────────────

export function validateProfileTools(profile: SubagentProfile, profileName?: string): void {
  if (profile.tools && profile.tools.length > 0 && profile.excludeTools && profile.excludeTools.length > 0) {
    throw new Error(
      `Profile${profileName ? ` "${profileName}"` : ""} has both "tools" (allowlist) and "excludeTools" (blacklist) set. These are mutually exclusive — choose one or the other.`,
    );
  }
}

export function applyExcludeTools(profile: SubagentProfile, allToolNames: string[]): SubagentProfile {
  if (!profile.excludeTools || profile.excludeTools.length === 0) return profile;
  const excludeSet = new Set(profile.excludeTools);
  const computedTools = allToolNames.filter((name) => !excludeSet.has(name));
  return { ...profile, tools: computedTools, excludeTools: undefined };
}

// ── Profile Loading from Markdown Files ──────────────────────────────

function loadProfilesFromDir(dir: string, profiles: SubagentProfiles): void {
  if (!existsSync(dir)) return;

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(".md"))) continue;

    const filePath = join(dir, entry.name);
    try {
      const content = readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

      const name = frontmatter.name;
      if (typeof name !== "string") continue;
      if (!name) continue;

      const profile: SubagentProfile = {};

      if (typeof frontmatter.provider === "string") profile.provider = frontmatter.provider;
      if (typeof frontmatter.model === "string") profile.model = frontmatter.model;
      if (typeof frontmatter.thinkingLevel === "string")
        profile.thinkingLevel = frontmatter.thinkingLevel as ThinkingLevel;
      if (typeof frontmatter.appendSystemPrompt === "string")
        profile.appendSystemPrompt = frontmatter.appendSystemPrompt;
      if (typeof frontmatter.apiKey === "string") profile.apiKey = frontmatter.apiKey;

      const trimmedBody = body.trim();
      if (trimmedBody) profile.systemPrompt = trimmedBody;

      const tools = parseStringOrArray(frontmatter.tools);
      if (tools) profile.tools = tools;

      const excludeTools = parseStringOrArray(frontmatter.excludeTools);
      if (excludeTools) profile.excludeTools = excludeTools;

      if (frontmatter.noTools === true) profile.noTools = true;
      if (frontmatter.noExtensions === true) profile.noExtensions = true;
      if (frontmatter.noSkills === true) profile.noSkills = true;
      if (frontmatter.noContextFiles === true) profile.noContextFiles = true;

      const extensions = parseStringOrArray(frontmatter.extensions);
      if (extensions) profile.extensions = extensions;

      const extraArgs = parseStringOrArray(frontmatter.extraArgs);
      if (extraArgs) profile.extraArgs = extraArgs;

      profiles[name] = profile;
    } catch (error) {
      console.warn(`Failed to load profile from ${filePath}:`, error instanceof Error ? error.message : error);
    }
  }
}

/**
 * Load subagent profiles from markdown files.
 * Project-local profiles override global profiles.
 */
export async function loadProfiles(cwd?: string): Promise<SubagentProfiles> {
  const now = Date.now();
  if (profilesCache && profilesCache.cwd === cwd && now - profilesCache.timestamp < CACHE_TTL) {
    return profilesCache.profiles;
  }

  const profiles: SubagentProfiles = {};

  // Load global profiles
  const globalDir = getGlobalProfilesDir();
  loadProfilesFromDir(globalDir, profiles);

  // Load project-local profiles (override globals)
  if (cwd) {
    const projectDir = getProjectProfilesDir(cwd);
    loadProfilesFromDir(projectDir, profiles);
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
 * Check whether a CLI argument is a tool-override flag (exact or equals-sign form).
 * Used to prevent extraArgs from bypassing profile tool restrictions.
 */
function isDangerousFlag(arg: string): boolean {
  return (
    arg === "--tools" ||
    arg.startsWith("--tools=") ||
    arg === "-t" ||
    arg.startsWith("-t=") ||
    arg === "--no-tools" ||
    arg.startsWith("--no-tools=") ||
    arg === "-nt" ||
    arg.startsWith("-nt=")
  );
}

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
    const hasToolRestrictions =
      profile.noTools === true ||
      (profile.tools !== undefined && profile.tools.length > 0) ||
      (profile.excludeTools !== undefined && profile.excludeTools.length > 0);

    for (const arg of profile.extraArgs) {
      // Block tool-override flags when profile has tool restrictions
      if (hasToolRestrictions && isDangerousFlag(arg)) {
        throw new Error(
          `Refusing extraArg "${arg}" which would override profile tool restrictions. Use the dedicated profile fields instead.`,
        );
      }
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
  else if (profile.tools && profile.tools.length > 0) parts.push(`tools=[${profile.tools.join(",")}]`);
  else if (profile.excludeTools && profile.excludeTools.length > 0)
    parts.push(`excludeTools=[${profile.excludeTools.join(",")}]`);
  return parts.join(", ");
}

// ── Profile Serialization ────────────────────────────────────────────

function serializeProfileToMarkdown(name: string, profile: SubagentProfile): string {
  const fmLines: string[] = ["---"];
  fmLines.push(`name: ${name}`);

  if (profile.provider !== undefined) fmLines.push(`provider: ${profile.provider}`);
  if (profile.model !== undefined) fmLines.push(`model: ${profile.model}`);
  if (profile.thinkingLevel !== undefined) fmLines.push(`thinkingLevel: ${profile.thinkingLevel}`);
  if (profile.appendSystemPrompt !== undefined) fmLines.push(`appendSystemPrompt: ${profile.appendSystemPrompt}`);
  if (profile.apiKey !== undefined) fmLines.push(`apiKey: ${profile.apiKey}`);

  if (profile.noTools !== undefined) fmLines.push(`noTools: ${profile.noTools}`);
  if (profile.noExtensions !== undefined) fmLines.push(`noExtensions: ${profile.noExtensions}`);
  if (profile.noSkills !== undefined) fmLines.push(`noSkills: ${profile.noSkills}`);
  if (profile.noContextFiles !== undefined) fmLines.push(`noContextFiles: ${profile.noContextFiles}`);

  if (profile.tools && profile.tools.length > 0) fmLines.push(`tools: ${profile.tools.join(",")}`);
  if (profile.excludeTools && profile.excludeTools.length > 0)
    fmLines.push(`excludeTools: ${profile.excludeTools.join(",")}`);
  if (profile.extensions && profile.extensions.length > 0) fmLines.push(`extensions: ${profile.extensions.join(",")}`);
  if (profile.extraArgs && profile.extraArgs.length > 0) fmLines.push(`extraArgs: ${profile.extraArgs.join(",")}`);

  fmLines.push("---");

  // Body is the system prompt
  if (profile.systemPrompt) {
    fmLines.push("");
    fmLines.push(profile.systemPrompt);
  }

  return `${fmLines.join("\n")}\n`;
}

// ── Profile Mutation ─────────────────────────────────────────────────

/**
 * Save (create or update) a profile as a markdown file in the given scope.
 */
export async function saveProfile(
  name: string,
  profile: SubagentProfile,
  scope: ProfileScope,
  cwd?: string,
): Promise<void> {
  const dir = scope === "project" ? getProjectProfilesDir(cwd ?? process.cwd()) : getGlobalProfilesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, `${name}.md`);
  const content = serializeProfileToMarkdown(name, profile);
  await writeFile(filePath, content, "utf8");
  invalidateProfilesCache();
}

/**
 * Delete a profile markdown file from the given scope.
 * Returns true if the profile existed and was deleted.
 */
export async function deleteProfile(name: string, scope: ProfileScope, cwd?: string): Promise<boolean> {
  const dir = scope === "project" ? getProjectProfilesDir(cwd ?? process.cwd()) : getGlobalProfilesDir();
  const filePath = join(dir, `${name}.md`);

  if (!existsSync(filePath)) return false;

  await unlink(filePath);
  invalidateProfilesCache();
  return true;
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
  else if (profile.excludeTools && profile.excludeTools.length > 0)
    lines.push(`  excludeTools:      [${profile.excludeTools.join(", ")}]`);
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
