import type { SubagentProfile } from "./profile-types";

/**
 * Get a human-readable summary of a profile for display in the TUI.
 */
export function profileSummary(name: string, profile: SubagentProfile): string {
  const parts: string[] = [`profile: ${name}`];
  if (profile.model) {parts.push(`model=${profile.model}`);}
  else if (profile.provider) {parts.push(`provider=${profile.provider}`);}
  if (profile.thinkingLevel) {parts.push(`thinking=${profile.thinkingLevel}`);}
  if (profile.systemPrompt) {parts.push("custom-system-prompt");}
  if (profile.appendSystemPrompt) {parts.push("appended-system-prompt");}
  if (profile.noTools) {parts.push("no-tools");}
  else if (profile.tools && profile.tools.length > 0) {parts.push(`tools=[${profile.tools.join(",")}]`);}
  else if (profile.excludeTools && profile.excludeTools.length > 0)
    {parts.push(`excludeTools=[${profile.excludeTools.join(",")}]`);}
  return parts.join(", ");
}

// ── Profile Serialization ────────────────────────────────────────────

export function serializeProfileToMarkdown(name: string, profile: SubagentProfile): string {
  const fmLines: string[] = ["---"];
  fmLines.push(`name: ${name}`);

  if (profile.provider !== undefined) {fmLines.push(`provider: ${profile.provider}`);}
  if (profile.model !== undefined) {fmLines.push(`model: ${profile.model}`);}
  if (profile.thinkingLevel !== undefined) {fmLines.push(`thinkingLevel: ${profile.thinkingLevel}`);}
  if (profile.appendSystemPrompt !== undefined) {fmLines.push(`appendSystemPrompt: ${profile.appendSystemPrompt}`);}
  if (profile.apiKey !== undefined) {fmLines.push(`apiKey: ${profile.apiKey}`);}

  if (profile.noTools !== undefined) {fmLines.push(`noTools: ${profile.noTools}`);}
  if (profile.noExtensions !== undefined) {fmLines.push(`noExtensions: ${profile.noExtensions}`);}
  if (profile.noSkills !== undefined) {fmLines.push(`noSkills: ${profile.noSkills}`);}
  if (profile.noContextFiles !== undefined) {fmLines.push(`noContextFiles: ${profile.noContextFiles}`);}

  if (profile.tools && profile.tools.length > 0) {fmLines.push(`tools: ${profile.tools.join(",")}`);}
  if (profile.excludeTools && profile.excludeTools.length > 0)
    {fmLines.push(`excludeTools: ${profile.excludeTools.join(",")}`);}
  if (profile.extensions && profile.extensions.length > 0) {fmLines.push(`extensions: ${profile.extensions.join(",")}`);}
  if (profile.extraArgs && profile.extraArgs.length > 0) {fmLines.push(`extraArgs: ${profile.extraArgs.join(",")}`);}

  fmLines.push("---");

  // Body is the system prompt
  if (profile.systemPrompt) {
    fmLines.push("");
    fmLines.push(profile.systemPrompt);
  }

  return `${fmLines.join("\n")}\n`;
}

/**
 * Format a profile as a human-readable multi-line string for display.
 */
export function formatProfileDetail(name: string, profile: SubagentProfile): string {
  const lines: string[] = [];
  lines.push(`Profile: ${name}`);
  if (profile.provider) {lines.push(`  provider:          ${profile.provider}`);}
  if (profile.model) {lines.push(`  model:             ${profile.model}`);}
  if (profile.thinkingLevel) {lines.push(`  thinkingLevel:     ${profile.thinkingLevel}`);}
  if (profile.systemPrompt) {lines.push(`  systemPrompt:      ${profile.systemPrompt}`);}
  if (profile.appendSystemPrompt) {lines.push(`  appendSystemPrompt: ${profile.appendSystemPrompt}`);}
  if (profile.noTools) {lines.push(`  noTools:           true`);}
  else if (profile.tools) {lines.push(`  tools:             [${profile.tools.join(", ")}]`);}
  else if (profile.excludeTools && profile.excludeTools.length > 0)
    {lines.push(`  excludeTools:      [${profile.excludeTools.join(", ")}]`);}
  if (profile.noExtensions) {lines.push(`  noExtensions:      true`);}
  if (profile.extensions) {lines.push(`  extensions:        [${profile.extensions.join(", ")}]`);}
  if (profile.noSkills) {lines.push(`  noSkills:          true`);}
  if (profile.noContextFiles) {lines.push(`  noContextFiles:    true`);}
  if (profile.apiKey) {
    const masked = profile.apiKey.length > 8 ? `${profile.apiKey.slice(0, 4)}****${profile.apiKey.slice(-4)}` : "****";
    lines.push(`  apiKey:            ${masked}`);
  }
  if (profile.extraArgs) {lines.push(`  extraArgs:         ${JSON.stringify(profile.extraArgs)}`);}
  return lines.join("\n");
}
