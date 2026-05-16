/**
 * Subagent Profile Type Definitions
 *
 * Shared types for the profile system, used by both profiles.ts and profile-formatting.ts
 * to avoid circular dependencies.
 */

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
