/**
 * Interactive Profile Editor
 *
 * Interactive wizard for creating and editing subagent profiles.
 * Uses the extension API's UI methods to prompt for profile settings.
 */

import type { SubagentProfile, ThinkingLevel } from "./profiles";
import { formatProfileDetail, type ProfileScope, saveProfile } from "./profiles";

/**
 * Interactive profile editor wizard.
 *
 * Prompts the user through a series of UI dialogs to configure or edit a profile.
 * Returns undefined if the user cancels at any point.
 */
export async function editProfileInteractive(name: string, initial: SubagentProfile, ctx: any): Promise<void> {
  const profile = { ...initial };
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

  // Scope
  const scope = await ctx.ui.select<ProfileScope>("Save to which scope?", [
    `Global (~/.pi/agent-profiles/${name}.md)`,
    `Project (.pi/agent-profiles/${name}.md)`,
  ]);
  if (!scope) return;
  const scopeValue: ProfileScope = scope.startsWith("Global") ? "global" : "project";

  // Provider
  const provider = await ctx.ui.input("Provider (e.g. anthropic, openai, dashscope):", profile.provider ?? "");
  if (provider === undefined) return;
  if (provider) profile.provider = provider;
  else delete profile.provider;

  // Model
  const model = await ctx.ui.input("Model (supports provider/id and :thinking shorthand):", profile.model ?? "");
  if (model === undefined) return;
  if (model) profile.model = model;
  else delete profile.model;

  // System prompt
  const hasSystem = await ctx.ui.confirm(
    "System prompt?",
    profile.systemPrompt ? "A custom system prompt is set. Keep it?" : "Set a custom system prompt?",
  );
  if (hasSystem) {
    const sp = await ctx.ui.editor("System prompt:", profile.systemPrompt ?? "You are a helpful coding assistant.");
    if (sp === undefined) return;
    profile.systemPrompt = sp;
  } else {
    delete profile.systemPrompt;
  }

  // Append system prompt
  const hasAppend = await ctx.ui.confirm(
    "Append to system prompt?",
    profile.appendSystemPrompt
      ? "An appended system prompt is set. Keep it?"
      : "Append text to the default system prompt?",
  );
  if (hasAppend) {
    const ap = await ctx.ui.input("Append text:", profile.appendSystemPrompt ?? "");
    if (ap === undefined) return;
    if (ap) profile.appendSystemPrompt = ap;
  } else {
    delete profile.appendSystemPrompt;
  }

  // Thinking level
  const hasThinking = await ctx.ui.confirm(
    "Thinking level?",
    profile.thinkingLevel ? `Thinking level is ${profile.thinkingLevel}. Set one?` : "Set a thinking level?",
  );
  if (hasThinking) {
    const tl = await ctx.ui.select<ThinkingLevel>("Thinking level:", THINKING_LEVELS);
    if (tl) profile.thinkingLevel = tl;
  } else {
    delete profile.thinkingLevel;
  }

  // Tools
  const hasTools = await ctx.ui.confirm(
    "Configure tools?",
    profile.tools || profile.noTools ? "Tool config is set. Change it?" : "Restrict which tools the subagent can use?",
  );
  if (hasTools) {
    const noTools = await ctx.ui.confirm("Disable all tools?", "");
    if (noTools) {
      profile.noTools = true;
      delete profile.tools;
    } else {
      delete profile.noTools;
      const toolsStr = await ctx.ui.input(
        "Tool allowlist (comma-separated, e.g. read,bash,grep):",
        profile.tools?.join(",") ?? "",
      );
      if (toolsStr === undefined) return;
      if (toolsStr.trim()) {
        profile.tools = toolsStr
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean);
      } else {
        delete profile.tools;
      }
    }
  }

  // Extensions
  const hasExts = await ctx.ui.confirm(
    "Configure extensions?",
    profile.noExtensions || profile.extensions ? "Extension config is set. Change it?" : "Configure extension loading?",
  );
  if (hasExts) {
    const noExt = await ctx.ui.confirm("Disable all extensions?", "");
    if (noExt) {
      profile.noExtensions = true;
      delete profile.extensions;
    } else {
      delete profile.noExtensions;
      const extStr = await ctx.ui.input("Extension paths (comma-separated):", profile.extensions?.join(",") ?? "");
      if (extStr === undefined) return;
      if (extStr.trim()) {
        profile.extensions = extStr
          .split(",")
          .map((e: string) => e.trim())
          .filter(Boolean);
      } else {
        delete profile.extensions;
      }
    }
  }

  // Review and save
  const summary = formatProfileDetail(name, profile);
  const confirmed = await ctx.ui.confirm(`Save profile "${name}"?`, `${summary}\n\nSave this profile?`);
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }

  await saveProfile(name, profile, scopeValue, ctx.cwd);
  ctx.ui.notify(`Profile "${name}" saved to ${scopeValue} agent-profiles.`, "info");
}
