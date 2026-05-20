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

import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  parseFrontmatter,
  stripFrontmatter,
  loadSkills as discoverSkills,
} from "@earendil-works/pi-coding-agent";
import { resolvePackageSkillPaths } from "./skill-discovery";
export { profileSummary, formatProfileDetail } from "./profile-formatting";
import { serializeProfileToMarkdown } from "./profile-formatting";
import type {
  SubagentProfile,
  SubagentProfiles,
  ThinkingLevel,
  ProfileInvocation,
} from "./profile-types";
export type {
  SubagentProfile,
  SubagentProfiles,
  ThinkingLevel,
  ProfileInvocation,
} from "./profile-types";

// ── Profile Types ────────────────────────────────────────────────────
// (Types moved to ./profile-types.ts)

// ── Profile Cache ─────────────────────────────────────────────────────

let profilesCache: {
  cwd: string | undefined;
  profiles: SubagentProfiles;
  timestamp: number;
} | null = null;
const CACHE_TTL = 5000; // 5 seconds

export function invalidateProfilesCache(): void {
  profilesCache = null;
}

// ── Helpers for array/string frontmatter fields ──────────────────────

function parseStringOrArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map(String);
  }
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

// ── Profile Tool Validation ───────────────────────────────────────────

export function validateProfileTools(profile: SubagentProfile, profileName?: string): void {
  if (
    profile.tools &&
    profile.tools.length > 0 &&
    profile.excludeTools &&
    profile.excludeTools.length > 0
  ) {
    throw new Error(
      `Profile${profileName ? ` "${profileName}"` : ""} has both "tools" (allowlist) and "excludeTools" (blacklist) set. These are mutually exclusive — choose one or the other.`,
    );
  }
}

export function applyExcludeTools(
  profile: SubagentProfile,
  allToolNames: string[],
): SubagentProfile {
  if (!profile.excludeTools || profile.excludeTools.length === 0) {
    return profile;
  }
  const excludeSet = new Set(profile.excludeTools);
  const computedTools = allToolNames.filter((name) => !excludeSet.has(name));
  return { ...profile, tools: computedTools, excludeTools: undefined };
}

/** Validate that skill-related profile fields are not mutually conflicting. Throws if suggestedSkills or loadSkills is combined with noSkills. */
export function validateProfileSkills(profile: SubagentProfile, profileName?: string): void {
  if (profile.suggestedSkills && profile.suggestedSkills.length > 0 && profile.noSkills) {
    throw new Error(
      `Profile${profileName ? ` "${profileName}"` : ""} has both "suggestedSkills" and "noSkills" set. These are mutually exclusive — --no-skills would override --skill flags.`,
    );
  }
  if (profile.loadSkills && profile.loadSkills.length > 0 && profile.noSkills) {
    throw new Error(
      `Profile${profileName ? ` "${profileName}"` : ""} has both "loadSkills" and "noSkills" set. These are mutually exclusive — --no-skills disables skill discovery.`,
    );
  }
}

/**
 * Resolve skill names in a profile to file paths and content.
 * suggestedSkills: names → file paths (for --skill CLI flags)
 * loadSkills: names → SKILL.md body → injected into appendSystemPrompt
 */
export async function resolveProfileSkills(
  profile: SubagentProfile,
  cwd: string,
  skillMap?: Map<string, { filePath: string; name: string; description: string }>,
): Promise<SubagentProfile> {
  if (!profile.suggestedSkills?.length && !profile.loadSkills?.length) {
    return profile;
  }

  let result: { skills: { filePath: string; name: string; description: string }[] };
  if (skillMap) {
    result = { skills: [...skillMap.values()] };
  } else {
    const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const packageSkillPaths = await resolvePackageSkillPaths(cwd, agentDir);
    result = discoverSkills({ cwd, agentDir, skillPaths: packageSkillPaths, includeDefaults: true });
  }
  const localSkillMap = skillMap ?? new Map(result.skills.map((s) => [s.name, s]));
  const available = result.skills.map((s) => s.name);
  const resolved: SubagentProfile = { ...profile };

  // Resolve suggestedSkills: names → file paths
  if (profile.suggestedSkills?.length) {
    const paths: string[] = [];
    const notFound: string[] = [];
    for (const name of profile.suggestedSkills) {
      const skill = localSkillMap.get(name);
      if (!skill) {
        notFound.push(name);
      } else {
        paths.push(skill.filePath);
      }
    }
    if (notFound.length > 0) {
      throw new Error(
        `Unknown skills: ${notFound.map((n) => `"${n}"`).join(", ")}. Available skills: ${available.join(", ") || "(none)"}`,
      );
    }
    resolved.suggestedSkills = paths;
  }

  // Resolve loadSkills: names → content injected into appendSystemPrompt
  if (profile.loadSkills?.length) {
    const skillParts: string[] = [];
    const loadNotFound: string[] = [];
    for (const name of profile.loadSkills) {
      const skill = localSkillMap.get(name);
      if (!skill) {
        loadNotFound.push(name);
      } else {
        const raw = readFileSync(skill.filePath, "utf-8");
        const body = stripFrontmatter(raw).trim();
        if (body) {
          skillParts.push(`<loaded_skill name="${skill.name}">\n${body}\n</loaded_skill>`);
        }
      }
    }
    if (loadNotFound.length > 0) {
      throw new Error(
        `Unknown skills: ${loadNotFound.map((n) => `"${n}"`).join(", ")}. Available skills: ${available.join(", ") || "(none)"}`,
      );
    }
    if (skillParts.length > 0) {
      const loadSkillsContent = `\n\n${skillParts.join("\n\n")}`;
      resolved.appendSystemPrompt = (resolved.appendSystemPrompt ?? "") + loadSkillsContent;
    }
    resolved.loadSkills = undefined;
  }

  return resolved;
}

// ── Profile Loading from Markdown Files ──────────────────────────────

function loadProfilesFromDir(dir: string, profiles: SubagentProfiles, scope: "global" | "project" = "global"): void {
  if (!existsSync(dir)) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(".md"))) {
      continue;
    }

    const filePath = join(dir, entry.name);
    try {
      const content = readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      const name = frontmatter.name;
      if (typeof name !== "string") {
        continue;
      }
      if (!name) {
        continue;
      }

      const profile: SubagentProfile = {};

      if (typeof frontmatter.provider === "string") {
        profile.provider = frontmatter.provider;
      }
      if (typeof frontmatter.model === "string") {
        profile.model = frontmatter.model;
      }
      if (typeof frontmatter.thinkingLevel === "string") {
        profile.thinkingLevel = frontmatter.thinkingLevel as ThinkingLevel;
      }
      if (typeof frontmatter.appendSystemPrompt === "string") {
        profile.appendSystemPrompt = frontmatter.appendSystemPrompt;
      }
      if (typeof frontmatter.apiKey === "string") {
        if (scope === "project") {
          console.warn(
            `Warning: Refusing to load apiKey from project-local profile "${name}" in ${filePath}. Move the profile to the global directory (~/.pi/agent/agent-profiles/) or use environment variables.`,
          );
        } else {
          profile.apiKey = frontmatter.apiKey;
        }
      }

      const trimmedBody = body.trim();
      if (trimmedBody) {
        profile.systemPrompt = trimmedBody;
      }

      const tools = parseStringOrArray(frontmatter.tools);
      if (tools) {
        profile.tools = tools;
      }

      const excludeTools = parseStringOrArray(frontmatter.excludeTools);
      if (excludeTools) {
        profile.excludeTools = excludeTools;
      }

      if (frontmatter.noTools === true) {
        profile.noTools = true;
      }
      if (frontmatter.noExtensions === true) {
        profile.noExtensions = true;
      }
      if (frontmatter.noSkills === true) {
        profile.noSkills = true;
      }
      if (frontmatter.noContextFiles === true) {
        profile.noContextFiles = true;
      }

      const extensions = parseStringOrArray(frontmatter.extensions);
      if (extensions) {
        profile.extensions = extensions;
      }

      const extraArgs = parseStringOrArray(frontmatter.extraArgs);
      if (extraArgs) {
        profile.extraArgs = extraArgs;
      }

      const suggestedSkills = parseStringOrArray(frontmatter.suggestedSkills);
      if (suggestedSkills) {
        profile.suggestedSkills = suggestedSkills;
      }

      const loadSkillsField = parseStringOrArray(frontmatter.loadSkills);
      if (loadSkillsField) {
        profile.loadSkills = loadSkillsField;
      }

      profiles[name] = profile;
    } catch (error) {
      console.warn(
        `Failed to load profile from ${filePath}:`,
        error instanceof Error ? error.message : error,
      );
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
    loadProfilesFromDir(projectDir, profiles, "project");
  }

  profilesCache = { cwd, profiles, timestamp: now };
  return profiles;
}

/**
 * Resolve a profile name to a SubagentProfile, falling back to
 * agentOverrides for backward compatibility.
 */
export function resolveProfile(
  profiles: SubagentProfiles,
  profileName: string,
): SubagentProfile | undefined {
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
function isWithinDir(filePath: string, dir: string): boolean {
  const resolved = resolve(filePath);
  const resolvedDir = resolve(dir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + sep);
}

export function profileToArgs(profile: SubagentProfile, cwd?: string, agentDir?: string): ProfileInvocation {
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

  if (profile.suggestedSkills) {
    const safeDirs: string[] = [];
    if (cwd) safeDirs.push(resolve(cwd));
    if (agentDir) safeDirs.push(resolve(agentDir));
    for (const skillPath of profile.suggestedSkills) {
      if (skillPath) {
        if (safeDirs.length > 0 && !safeDirs.some((d) => isWithinDir(skillPath, d))) {
          throw new Error(
            `Refusing skill path outside allowed directories: ${skillPath}`,
          );
        }
        args.push("--skill", skillPath);
      }
    }
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
  const dir =
    scope === "project" ? getProjectProfilesDir(cwd ?? process.cwd()) : getGlobalProfilesDir();
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
export async function deleteProfile(
  name: string,
  scope: ProfileScope,
  cwd?: string,
): Promise<boolean> {
  const dir =
    scope === "project" ? getProjectProfilesDir(cwd ?? process.cwd()) : getGlobalProfilesDir();
  const filePath = join(dir, `${name}.md`);

  if (!existsSync(filePath)) {
    return false;
  }

  await unlink(filePath);
  invalidateProfilesCache();
  return true;
}
