import type { SubagentProfile } from "./profile-types";

/** Quote a string value for safe YAML output */
function yamlQuote(value: string): string {
  // Quote if contains YAML-special characters
  if (/:|#|'|"|\n|^\s|\s$|^[&*?|>!%@`{[~,]|^-(\s|$)/.test(value)) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return '"' + escaped + '"';
  }
  return value;
}

/**
 * Get a human-readable summary of a profile for display in the TUI.
 */
export function profileSummary(name: string, profile: SubagentProfile): string {
  const parts: string[] = [`profile: ${name}`];
  if (profile.model) {
    parts.push(`model=${profile.model}`);
  } else if (profile.provider) {
    parts.push(`provider=${profile.provider}`);
  }
  if (profile.thinkingLevel) {
    parts.push(`thinking=${profile.thinkingLevel}`);
  }
  if (profile.systemPrompt) {
    parts.push("custom-system-prompt");
  }
  if (profile.appendSystemPrompt) {
    parts.push("appended-system-prompt");
  }
  if (profile.noTools) {
    parts.push("no-tools");
  } else if (profile.tools && profile.tools.length > 0) {
    parts.push(`tools=[${profile.tools.join(",")}]`);
  } else if (profile.excludeTools && profile.excludeTools.length > 0) {
    parts.push(`excludeTools=[${profile.excludeTools.join(",")}]`);
  }
  if (profile.suggestedSkills && profile.suggestedSkills.length > 0) {
    parts.push(`suggestedSkills=[${profile.suggestedSkills.join(",")}]`);
  }
  if (profile.loadSkills && profile.loadSkills.length > 0) {
    parts.push(`loadSkills=[${profile.loadSkills.join(",")}]`);
  }
  return parts.join(", ");
}

// ── Profile Serialization ────────────────────────────────────────────

/** String-valued profile fields for frontmatter serialization. */
const SERIALIZABLE_STRING_FIELDS = [
  "provider",
  "model",
  "thinkingLevel",
  "appendSystemPrompt",
  "apiKey",
] as const;

/** Boolean-valued profile fields for frontmatter serialization. */
const SERIALIZABLE_BOOLEAN_FIELDS = [
  "noTools",
  "noExtensions",
  "noSkills",
  "noContextFiles",
] as const;

/** Array-valued profile fields serialized as comma-joined strings. */
const SERIALIZABLE_ARRAY_FIELDS = [
  "tools",
  "excludeTools",
  "extensions",
  "extraArgs",
  "suggestedSkills",
  "loadSkills",
] as const;

function pushFrontmatterLines(fmLines: string[], name: string, profile: SubagentProfile): void {
  fmLines.push("---");
  fmLines.push(`name: ${yamlQuote(name)}`);

  for (const field of SERIALIZABLE_STRING_FIELDS) {
    const value = profile[field];
    if (value !== undefined) fmLines.push(`${field}: ${yamlQuote(value)}`);
  }
  for (const field of SERIALIZABLE_BOOLEAN_FIELDS) {
    const value = profile[field];
    if (value !== undefined) fmLines.push(`${field}: ${value}`);
  }
  for (const field of SERIALIZABLE_ARRAY_FIELDS) {
    const value = profile[field];
    if (value && value.length > 0) {
      fmLines.push(`${field}: ${yamlQuote(value.join(","))}`);
    }
  }
}

export function serializeProfileToMarkdown(name: string, profile: SubagentProfile): string {
  const fmLines: string[] = [];
  pushFrontmatterLines(fmLines, name, profile);
  fmLines.push("---");

  // Body is the system prompt
  if (profile.systemPrompt) {
    fmLines.push("");
    fmLines.push(profile.systemPrompt);
  }

  return `${fmLines.join("\n")}\n`;
}

/** Fields displayed as simple string values in profile detail. */
const DETAIL_STRING_FIELDS: Array<{ key: keyof SubagentProfile; label: string }> = [
  { key: "provider", label: "provider:" },
  { key: "model", label: "model:" },
  { key: "thinkingLevel", label: "thinkingLevel:" },
  { key: "systemPrompt", label: "systemPrompt:" },
  { key: "appendSystemPrompt", label: "appendSystemPrompt:" },
];;

/** Fields displayed as comma-separated array values in profile detail. */
const DETAIL_ARRAY_FIELDS: Array<{ key: keyof SubagentProfile; label: string }> = [
  { key: "extensions", label: "extensions:" },
  { key: "suggestedSkills", label: "suggestedSkills:" },
  { key: "loadSkills", label: "loadSkills:" },
];;

function pushDetailToolLines(lines: string[], profile: SubagentProfile): void {
  if (profile.noTools) {
    lines.push(`  noTools:           true`);
  } else if (profile.tools) {
    lines.push(`  tools:             [${profile.tools.join(", ")}]`);
  } else if (profile.excludeTools && profile.excludeTools.length > 0) {
    lines.push(`  excludeTools:      [${profile.excludeTools.join(", ")}]`);
  }
}

function pushDetailSpecialLines(lines: string[], profile: SubagentProfile): void {
  if (profile.noExtensions) lines.push(`  noExtensions:      true`);
  if (profile.noSkills) lines.push(`  noSkills:          true`);
  if (profile.noContextFiles) lines.push(`  noContextFiles:    true`);
  if (profile.apiKey) {
    const masked =
      profile.apiKey.length > 8
        ? `${profile.apiKey.slice(0, 4)}****${profile.apiKey.slice(-4)}`
        : "****";
    lines.push(`  apiKey:            ${masked}`);
  }
  if (profile.extraArgs) {
    lines.push(`  extraArgs:         ${JSON.stringify(profile.extraArgs)}`);
  }
}

/**
 * Format a profile as a human-readable multi-line string for display.
 */
export function formatProfileDetail(name: string, profile: SubagentProfile): string {
  const lines: string[] = [];
  lines.push(`Profile: ${name}`);

  for (const { key, label } of DETAIL_STRING_FIELDS) {
    const value = profile[key];
    if (typeof value === "string") {
      lines.push(`  ${label.padEnd(label === "appendSystemPrompt:" ? 20 : 19)}${value}`);
    }
  }

  pushDetailToolLines(lines, profile);

  for (const { key, label } of DETAIL_ARRAY_FIELDS) {
    const value = profile[key];
    if (Array.isArray(value) && value.length > 0) {
      lines.push(`  ${label.padEnd(19)}[${value.join(", ")}]`);
    }
  }

  pushDetailSpecialLines(lines, profile);
  return lines.join("\n");
}
