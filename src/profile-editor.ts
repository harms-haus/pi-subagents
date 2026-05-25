/**
 * Interactive Profile Editor
 *
 * Interactive wizard for creating and editing subagent profiles.
 * Uses the extension API's UI methods to prompt for profile settings.
 */

import {
  formatProfileDetail,
  saveProfile,
  type ProfileScope,
  type SubagentProfile,
  type ThinkingLevel,
} from "./profiles";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Subset of ExtensionContext used by the profile editor. */
type ProfileEditorUIContext = ExtensionUIContext;

type ProfileEditorContext = {
  ui: ProfileEditorUIContext;
  cwd: string;
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Sentinel returned by step helpers when the user cancels. */
const CANCELLED = Symbol("CANCELLED");
type StepResult = typeof CANCELLED | true;

// ── Individual Editor Steps ──────────────────────────────────────────

async function promptScope(
  ui: ProfileEditorUIContext,
  name: string,
): Promise<ProfileScope | typeof CANCELLED> {
  const scope = await ui.select("Save to which scope?", [
    `Global (~/.pi/agent-profiles/${name}.md)`,
    `Project (.pi/agent-profiles/${name}.md)`,
  ]);
  if (!scope) return CANCELLED;
  return scope.startsWith("Global") ? "global" : "project";
}

async function promptProvider(
  ui: ProfileEditorUIContext,
  profile: SubagentProfile,
): Promise<StepResult> {
  const value = await ui.input("Provider (e.g. anthropic, openai, dashscope):", profile.provider ?? "");
  if (value === undefined) return CANCELLED;
  if (value) {
    profile.provider = value;
  } else {
    delete profile.provider;
  }
  return true;
}

async function promptModel(
  ui: ProfileEditorUIContext,
  profile: SubagentProfile,
): Promise<StepResult> {
  const value = await ui.input("Model (supports provider/id and :thinking shorthand):", profile.model ?? "");
  if (value === undefined) return CANCELLED;
  if (value) {
    profile.model = value;
  } else {
    delete profile.model;
  }
  return true;
}

async function promptSystemPrompt(
  ui: ProfileEditorUIContext,
  profile: SubagentProfile,
): Promise<StepResult> {
  const hasSystem = await ui.confirm(
    "System prompt?",
    profile.systemPrompt
      ? "A custom system prompt is set. Keep it?"
      : "Set a custom system prompt?",
  );
  if (hasSystem) {
    const sp = await ui.editor(
      "System prompt:",
      profile.systemPrompt ?? "You are a helpful coding assistant.",
    );
    if (sp === undefined) return CANCELLED;
    profile.systemPrompt = sp;
  } else {
    delete profile.systemPrompt;
  }
  return true;
}

async function promptAppendSystemPrompt(
  ui: ProfileEditorUIContext,
  profile: SubagentProfile,
): Promise<StepResult> {
  const hasAppend = await ui.confirm(
    "Append to system prompt?",
    profile.appendSystemPrompt
      ? "An appended system prompt is set. Keep it?"
      : "Append text to the default system prompt?",
  );
  if (hasAppend) {
    const ap = await ui.input("Append text:", profile.appendSystemPrompt ?? "");
    if (ap === undefined) return CANCELLED;
    if (ap) {
      profile.appendSystemPrompt = ap;
    }
  } else {
    delete profile.appendSystemPrompt;
  }
  return true;
}

async function promptThinkingLevel(
  ui: ProfileEditorUIContext,
  profile: SubagentProfile,
): Promise<StepResult> {
  const hasThinking = await ui.confirm(
    "Thinking level?",
    profile.thinkingLevel
      ? `Thinking level is ${profile.thinkingLevel}. Set one?`
      : "Set a thinking level?",
  );
  if (hasThinking) {
    const tl = await ui.select("Thinking level:", THINKING_LEVELS);
    if (tl) {
      profile.thinkingLevel = tl as ThinkingLevel;
    }
  } else {
    delete profile.thinkingLevel;
  }
  return true;
}

async function promptToolListInput(
  ui: ProfileEditorUIContext,
  label: string,
  current: string | undefined,
): Promise<string[] | undefined> {
  const str = await ui.input(label, current ?? "");
  if (str === undefined) return undefined;
  if (str.trim()) {
    return str
      .split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);
  }
  return [];
}

async function promptToolsConfig(
  ui: ProfileEditorUIContext,
  profile: SubagentProfile,
): Promise<StepResult> {
  const hasTools = await ui.confirm(
    "Configure tools?",
    profile.tools || profile.excludeTools || profile.noTools
      ? "Tool config is set. Change it?"
      : "Restrict which tools the subagent can use?",
  );
  if (!hasTools) return true;

  const noTools = await ui.confirm("Disable all tools?", "");
  if (noTools) {
    profile.noTools = true;
    delete profile.tools;
    delete profile.excludeTools;
    return true;
  }

  delete profile.noTools;
  const toolMode = await ui.select("Select tool mode:", [
    "Allowlist (only these tools)",
    "Blacklist (all tools except these)",
  ]);
  if (!toolMode) return CANCELLED;

  if (toolMode.startsWith("Blacklist")) {
    delete profile.tools;
    const list = await promptToolListInput(
      ui,
      "Tool blacklist (comma-separated, e.g. read,bash,grep):",
      profile.excludeTools?.join(","),
    );
    if (list === undefined) return CANCELLED;
    if (list.length > 0) {
      profile.excludeTools = list;
    } else {
      delete profile.excludeTools;
    }
  } else {
    delete profile.excludeTools;
    const list = await promptToolListInput(
      ui,
      "Tool allowlist (comma-separated, e.g. read,bash,grep):",
      profile.tools?.join(","),
    );
    if (list === undefined) return CANCELLED;
    if (list.length > 0) {
      profile.tools = list;
    } else {
      delete profile.tools;
    }
  }
  return true;
}

async function promptExtensionsConfig(
  ui: ProfileEditorUIContext,
  profile: SubagentProfile,
): Promise<StepResult> {
  const hasExts = await ui.confirm(
    "Configure extensions?",
    profile.noExtensions || profile.extensions
      ? "Extension config is set. Change it?"
      : "Configure extension loading?",
  );
  if (!hasExts) return true;

  const noExt = await ui.confirm("Disable all extensions?", "");
  if (noExt) {
    profile.noExtensions = true;
    delete profile.extensions;
    return true;
  }

  delete profile.noExtensions;
  const extStr = await ui.input(
    "Extension paths (comma-separated):",
    profile.extensions?.join(",") ?? "",
  );
  if (extStr === undefined) return CANCELLED;
  if (extStr.trim()) {
    profile.extensions = extStr
      .split(",")
      .map((e: string) => e.trim())
      .filter(Boolean);
  } else {
    delete profile.extensions;
  }
  return true;
}

async function promptSkillsConfig(
  ui: ProfileEditorUIContext,
  profile: SubagentProfile,
): Promise<StepResult> {
  if (profile.suggestedSkills || profile.loadSkills) {
    const remove = await ui.confirm(
      "Remove skills?",
      "Skill config is set. Remove existing skill configuration?",
    );
    if (remove) {
      delete profile.suggestedSkills;
      delete profile.loadSkills;
    }
    return true;
  }

  const add = await ui.confirm(
    "Configure skills?",
    "Configure skill loading for the subagent?",
  );
  if (!add) return true;

  const suggestedStr = await ui.input(
    "Suggested skills (comma-separated skill names, model chooses to load):",
    "",
  );
  if (suggestedStr === undefined) return CANCELLED;
  if (suggestedStr.trim()) {
    profile.suggestedSkills = suggestedStr
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
  }

  const loadStr = await ui.input(
    "Pre-loaded skills (comma-separated skill names, content injected into system prompt):",
    "",
  );
  if (loadStr === undefined) return CANCELLED;
  if (loadStr.trim()) {
    profile.loadSkills = loadStr
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
  }
  return true;
}

// ── Main Wizard ──────────────────────────────────────────────────────

/**
 * Interactive profile editor wizard.
 *
 * Prompts the user through a series of UI dialogs to configure or edit a profile.
 * Returns undefined if the user cancels at any point.
 */
export async function editProfileInteractive(
  name: string,
  initial: SubagentProfile,
  ctx: ProfileEditorContext,
): Promise<void> {
  const profile = { ...initial };

  const scopeValue = await promptScope(ctx.ui, name);
  if (scopeValue === CANCELLED) return;

  let result: StepResult;

  result = await promptProvider(ctx.ui, profile);
  if (result === CANCELLED) return;

  result = await promptModel(ctx.ui, profile);
  if (result === CANCELLED) return;

  result = await promptSystemPrompt(ctx.ui, profile);
  if (result === CANCELLED) return;

  result = await promptAppendSystemPrompt(ctx.ui, profile);
  if (result === CANCELLED) return;

  result = await promptThinkingLevel(ctx.ui, profile);
  if (result === CANCELLED) return;

  result = await promptToolsConfig(ctx.ui, profile);
  if (result === CANCELLED) return;

  result = await promptExtensionsConfig(ctx.ui, profile);
  if (result === CANCELLED) return;

  result = await promptSkillsConfig(ctx.ui, profile);
  if (result === CANCELLED) return;

  // Review and save
  const summary = formatProfileDetail(name, profile);
  const confirmed = await ctx.ui.confirm(
    `Save profile "${name}"?`,
    `${summary}\n\nSave this profile?`,
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }

  await saveProfile(name, profile, scopeValue, ctx.cwd);
  ctx.ui.notify(`Profile "${name}" saved to ${scopeValue} agent-profiles.`, "info");
}
