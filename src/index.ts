/**
 * pi-subagents Extension
 *
 * Allows the main agent to spawn parallel sub-agents, with each sub-agent's
 * latest output rendered in a rolling TUI window inline with the main agent's
 * conversation history.
 *
 * Supports named profiles configured in settings.json under
 * `subagents.profiles` to pre-configure provider/model, system prompts,
 * thinking levels, and other model settings per profile.
 *
 * Usage (from the LLM):
 *   delegate_to_subagents({ tasks: [{ name: "test", prompt: "...", profile: "code-reviewer" }] })
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Container, Markdown, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  loadProfiles,
  resolveProfile,
  profileToArgs,
  profileSummary,
  saveProfile,
  deleteProfile,
  formatProfileDetail,
  type SubagentProfile,
  type SubagentProfiles,
  type ProfileScope,
} from "./profiles";

// ── Configuration ────────────────────────────────────────────────────

const DEFAULT_MAX_LINES = 10;
const MAX_PARALLEL_TASKS = 16;
const MAX_CONCURRENCY = 4;

// ── Types ────────────────────────────────────────────────────────────

interface SubAgentTask {
  name: string;
  prompt: string;
  cwd?: string;
  /** Named profile from settings.json subagents.profiles */
  profile?: string;
}

interface SubAgentWindow {
  name: string;
  status: "running" | "completed" | "error";
  lines: string[];
  allMessages: string[];
  exitCode: number | null;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Name of the profile used, if any */
  profileName?: string;
  /** Human-readable profile summary for display */
  profileInfo?: string;
}

interface WindowedSubagentDetails {
  windows: SubAgentWindow[];
  maxLinesPerWindow: number;
  globalStatus: "running" | "done";
}

// ── Schema ───────────────────────────────────────────────────────────

const TaskSchema = Type.Object({
  name: Type.String({ description: "Display name for this sub-agent window" }),
  prompt: Type.String({ description: "The task/prompt to send to the sub-agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this sub-agent" })),
  profile: Type.Optional(Type.String({
    description: "Named subagent profile from settings (sets provider/model, system prompt, thinking level, etc.)",
  })),
});

const DelegateParams = Type.Object({
  tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_PARALLEL_TASKS }),
  maxLinesPerWindow: Type.Optional(
    Type.Number({ default: DEFAULT_MAX_LINES, description: "Max lines to show per sub-agent window" }),
  ),
  profile: Type.Optional(Type.String({
    description: "Default profile for all tasks (overridden by per-task profile)",
  })),
});

// ── ANSI Stripping ───────────────────────────────────────────────────

const ANSI_REGEX =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

// ── Rolling Buffer ─────────────────────────────────────────────────────

function appendLineToWindow(win: SubAgentWindow, line: string, maxLines: number) {
  const clean = stripAnsi(line).trimEnd();
  if (!clean) return;
  win.lines.push(clean);
  while (win.lines.length > maxLines) {
    win.lines.shift();
  }
  win.allMessages.push(clean);
}

// ── Sub-Agent Spawner ────────────────────────────────────────────────

function getPiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}

async function runSubAgent(
  task: SubAgentTask,
  win: SubAgentWindow,
  maxLines: number,
  signal: AbortSignal | undefined,
  onUpdate: () => void,
  profile?: SubagentProfile,
): Promise<void> {
  const invocation = getPiInvocation();
  const args = [
    ...invocation.args,
    "--mode", "json",
    "-p",
    "--no-session",
  ];

  // Inject profile-specific CLI arguments before the prompt
  if (profile) {
    args.push(...profileToArgs(profile));
  }

  args.push(task.prompt);

  let buffer = "";
  let bufferTimeout: ReturnType<typeof setTimeout> | null = null;

  // Debounced onUpdate to reduce TUI pressure
  const debouncedUpdate = () => {
    if (bufferTimeout) clearTimeout(bufferTimeout);
    bufferTimeout = setTimeout(() => onUpdate(), 50);
  };

  return new Promise((resolve) => {
    const proc = spawn(invocation.command, args, {
      cwd: task.cwd ?? process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        appendLineToWindow(win, line, maxLines);
        debouncedUpdate();
        return;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        const msg = event.message as Message;
        for (const part of msg.content) {
          if (part.type === "text") {
            const textLines = part.text.split("\n");
            for (const textLine of textLines) {
              appendLineToWindow(win, textLine, maxLines);
            }
          }
          if (part.type === "toolCall") {
            const args = (part as any).arguments || {};
            const preview = JSON.stringify(args).slice(0, 60);
            appendLineToWindow(win, `→ ${(part as any).name}: ${preview}`, maxLines);
          }
        }
        if (msg.model) win.model = msg.model;
        if (msg.stopReason) win.stopReason = msg.stopReason;
        if (msg.errorMessage) win.errorMessage = msg.errorMessage;
        debouncedUpdate();
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        appendLineToWindow(win, `[stderr]: ${text}`, maxLines);
        debouncedUpdate();
      }
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      if (bufferTimeout) clearTimeout(bufferTimeout);
      win.exitCode = code ?? 0;
      if (code !== 0 || win.stopReason === "error" || win.stopReason === "aborted") {
        win.status = "error";
      } else {
        win.status = "completed";
      }
      onUpdate();
      resolve();
    });

    proc.on("error", () => {
      if (bufferTimeout) clearTimeout(bufferTimeout);
      win.exitCode = 1;
      win.status = "error";
      win.errorMessage = win.errorMessage || "Failed to spawn sub-agent process";
      onUpdate();
      resolve();
    });

    if (signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener("abort", killProc, { once: true });
      }
    }
  });
}

// ── Concurrency Helper ───────────────────────────────────────────────

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Formatting Helpers ──────────────────────────────────────────────

function joinStatusParts(parts: { text: string; color?: string }[]): string {
  const nonEmpty = parts.filter((p) => p.text);
  let result = "";
  for (let i = 0; i < nonEmpty.length; i++) {
    result += nonEmpty[i].text;
    if (i < nonEmpty.length - 1) result += ", ";
  }
  return result;
}

function buildWindowHeader(win: SubAgentWindow, themeFgr: (color: string, text: string) => string): string {
  const icon = win.status === "running" ? "⏳"
    : win.status === "error" ? "✗"
    : "✓";
  const color = win.status === "running" ? "warning"
    : win.status === "error" ? "error"
    : "success";
  return themeFgr(color, icon) + " " + themeFgr("accent", themeFgr("toolTitle", win.name));
}

// ── Interactive Profile Editor ───────────────────────────────────────

async function editProfileInteractive(
  name: string,
  initial: SubagentProfile,
  ctx: any,
): Promise<void> {
  const profile = { ...initial };
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

  // Scope
  const scope = await ctx.ui.select<ProfileScope>(
    "Save to which scope?",
    [
      "Global (~/.pi/agent/settings.json)",
      "Project (.pi/settings.json)",
    ],
  );
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
    profile.appendSystemPrompt ? "An appended system prompt is set. Keep it?" : "Append text to the default system prompt?",
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
    const tl = await ctx.ui.select<ThinkingLevel>("Thinking level:",
      THINKING_LEVELS,
    );
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
        profile.tools = toolsStr.split(",").map((t: string) => t.trim()).filter(Boolean);
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
      const extStr = await ctx.ui.input(
        "Extension paths (comma-separated):",
        profile.extensions?.join(",") ?? "",
      );
      if (extStr === undefined) return;
      if (extStr.trim()) {
        profile.extensions = extStr.split(",").map((e: string) => e.trim()).filter(Boolean);
      } else {
        delete profile.extensions;
      }
    }
  }

  // Review and save
  const summary = formatProfileDetail(name, profile);
  const confirmed = await ctx.ui.confirm(
    `Save profile "${name}"?`,
    summary + "\n\nSave this profile?",
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }

  await saveProfile(name, profile, scopeValue, ctx.cwd);
  ctx.ui.notify(`Profile "${name}" saved to ${scopeValue} settings.`, "info");
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate_to_subagents",
    label: "Delegate to Sub-agents",
    description: [
      "Spawn one or more parallel sub-agents to work on separate tasks.",
      "Each sub-agent runs in an isolated pi process with its own context window.",
      "Live progress from each sub-agent is shown in a rolling window in the TUI.",
      "Optionally specify a profile name to pre-configure provider/model, system prompt,",
      "thinking level, and other model settings. Profiles are defined in settings.json",
      "under subagents.profiles. A top-level profile parameter sets a default for all tasks;",
      "each task can override with its own profile.",
    ].join(" "),
    parameters: DelegateParams,
    promptSnippet: "Use when the user wants multiple independent tasks done in parallel",
    promptGuidelines: [
      "Use delegate_to_subagents when the user asks for multiple independent tasks.\n",
      "Each task gets its own isolated pi sub-agent process with full tool access.\n",
      "Provide a descriptive `name` for each task so the TUI window is labeled.\n",
      "Set `maxLinesPerWindow` to control how many lines of live output are shown.\n",
      "Use the `profile` parameter (top-level or per-task) to select a named subagent profile",
      "that pre-configures provider/model, system prompt, thinking level, and other settings.\n",
      "When the user mentions a specific agent role like \"use the code-reviewer profile\"",
      "or \"run this as the researcher\", set the profile field accordingly.\n",
    ],

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const maxLines = params.maxLinesPerWindow ?? DEFAULT_MAX_LINES;

      // Load profiles from settings (global + project-local)
      const profiles = await loadProfiles(ctx.cwd);

      const windows: SubAgentWindow[] = params.tasks.map((t) => {
        const resolvedProfileName = t.profile ?? params.profile;
        const resolvedProfile = resolvedProfileName
          ? resolveProfile(profiles, resolvedProfileName)
          : undefined;

        return {
          name: t.name,
          status: "running",
          lines: [],
          allMessages: [],
          exitCode: null,
          profileName: resolvedProfileName,
          profileInfo: resolvedProfile ? profileSummary(resolvedProfileName!, resolvedProfile) : undefined,
        };
      });

      const makeDetails = (): WindowedSubagentDetails => ({
        windows,
        maxLinesPerWindow: maxLines,
        globalStatus: windows.every((w) => w.status !== "running") ? "done" : "running",
      });

      const emitUpdate = () => {
        if (onUpdate) {
          onUpdate({
            content: [{ type: "text", text: getSummaryText(windows) }],
            details: makeDetails(),
          });
        }
      };

      await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
        const win = windows[index];
        const resolvedProfileName = task.profile ?? params.profile;
        const resolvedProfile = resolvedProfileName
          ? resolveProfile(profiles, resolvedProfileName)
          : undefined;

        if (resolvedProfileName && !resolvedProfile) {
          win.status = "error";
          win.errorMessage = `Unknown profile: "${resolvedProfileName}". Available profiles: ${Object.keys(profiles).join(", ") || "(none)"}`;
          win.exitCode = 1;
          emitUpdate();
          return;
        }

        await runSubAgent(task, win, maxLines, signal, emitUpdate, resolvedProfile);
      });

      const summaryLines: string[] = [];
      for (const win of windows) {
        const icon = win.status === "completed" ? "✓" : "✗";
        let line = `${icon} ${win.name}: ${win.status}`;
        if (win.profileName) {
          line += ` (${win.profileInfo ?? win.profileName})`;
        }
        summaryLines.push(line);
      }

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: makeDetails(),
      };
    },

    // ── renderCall ─────────────────────────────────────────────────
    renderCall(args, theme, _context) {
      const count = args.tasks?.length ?? 1;
      const taskProfiles = (args.tasks ?? [])
        .map((t: any) => t.profile)
        .filter(Boolean) as string[];
      const defaultProfile = args.profile;

      let text =
        theme.fg("toolTitle", theme.bold("delegate_to_subagents ")) +
        theme.fg("accent", `${count} sub-agent${count > 1 ? "s" : ""}`);

      if (defaultProfile) {
        text += theme.fg("dim", ` (default profile: ${defaultProfile})`);
      }
      if (taskProfiles.length > 0) {
        text += theme.fg("dim", ` profiles: [${taskProfiles.join(", ")}]`);
      }
      return new Text(text, 0, 0);
    },

    // ── renderResult: Live rolling window display ──────────────────
    renderResult(result, { isPartial, expanded }, theme, _context) {
      const details = result.details as WindowedSubagentDetails | undefined;
      if (!details) {
        return new Text("(no sub-agent details)", 0, 0);
      }

      const container = new Container();
      const running = details.windows.filter((w) => w.status === "running").length;
      const done = details.windows.filter((w) => w.status === "completed").length;
      const errors = details.windows.filter((w) => w.status === "error").length;

      // ── Global status header ──
      {
        let header = theme.fg("toolTitle", theme.bold("Sub-agents: "));
        const parts: string[] = [];
        if (running > 0) parts.push(theme.fg("warning", `${running} running`));
        if (done > 0) parts.push(theme.fg("success", `${done} done`));
        if (errors > 0) parts.push(theme.fg("error", `${errors} error${errors > 1 ? "s" : ""}`));
        header += parts.join(theme.fg("dim", ", "));
        header += theme.fg("dim", ` (${details.maxLinesPerWindow}-line window)`);
        container.addChild(new Text(header, 0, 0));
        container.addChild(new Spacer(1));
      }

      // ── Per-agent windows ──
      for (const win of details.windows) {
        const icon = win.status === "running" ? "⏳"
          : win.status === "error" ? "✗"
          : "✓";
        const color = win.status === "running" ? "warning"
          : win.status === "error" ? "error"
          : "success";

        let headerLine = theme.fg(color, icon) + " " + theme.fg("accent", theme.bold(win.name));
        if (win.profileName) {
          headerLine += theme.fg("dim", ` [${win.profileInfo ?? win.profileName}]`);
        }
        container.addChild(new Text(headerLine, 0, 0));

        if (expanded) {
          // Expanded (Ctrl+O): show all captured messages, not just latest N
          if (win.allMessages.length === 0) {
            container.addChild(new Text(theme.fg("muted", "  (no output)"), 0, 0));
          } else {
            for (const msg of win.allMessages) {
              const lines = msg.split("\n");
              for (const line of lines) {
                container.addChild(new Text("  " + line, 0, 0));
              }
            }
          }
        } else {
          // Collapsed: rolling window (latest N lines)
          if (win.lines.length === 0) {
            container.addChild(new Text(theme.fg("muted", "  (starting...)"), 0, 0));
          } else {
            for (const line of win.lines) {
              container.addChild(new Text("  " + line, 0, 0));
            }
          }
        }

        if (win.status === "error" && win.errorMessage) {
          container.addChild(
            new Text(theme.fg("error", "  Error: " + win.errorMessage), 0, 0)
          );
        }

        container.addChild(new Spacer(1));
      }

      // ── Footer ──
      if (running > 0) {
        container.addChild(new Text(theme.fg("muted", `${running} running...`), 0, 0));
      }

      return container;
    },
  });

  // ── /profile command ──────────────────────────────────────────────

  pi.registerCommand("profile", {
    description: "Manage subagent profiles (list, show, create, edit, delete)",

    async getArgumentCompletions(prefix: string) {
      const profiles = await loadProfiles();
      const subs = ["list", "show", "create", "edit", "delete"];
      const items = [...subs, ...Object.keys(profiles)]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },

    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);
      const sub = tokens[0] ?? "list";

      // ── /profile list ──
      if (sub === "list" || sub === "ls") {
        const profiles = await loadProfiles(ctx.cwd);
        const names = Object.keys(profiles);
        if (names.length === 0) {
          ctx.ui.notify("No subagent profiles defined. Use /profile create to add one.", "info");
          return;
        }
        const lines = names.map((n) => "  " + profileSummary(n, profiles[n]));
        ctx.ui.notify("Subagent profiles:\n" + lines.join("\n"), "info");
        return;
      }

      // ── /profile show <name> ──
      if (sub === "show") {
        const name = tokens[1];
        if (!name) {
          ctx.ui.notify("Usage: /profile show <name>", "warning");
          return;
        }
        const profiles = await loadProfiles(ctx.cwd);
        const profile = profiles[name];
        if (!profile) {
          ctx.ui.notify(`Profile "${name}" not found. Available: ${Object.keys(profiles).join(", ") || "(none)"}`, "error");
          return;
        }
        ctx.ui.notify(formatProfileDetail(name, profile), "info");
        return;
      }

      // ── /profile create <name> ──
      if (sub === "create" || sub === "new") {
        const name = tokens[1];
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
          ctx.ui.notify("Usage: /profile create <name>  (alphanumeric, hyphens, underscores)", "warning");
          return;
        }
        const profiles = await loadProfiles(ctx.cwd);
        if (profiles[name]) {
          ctx.ui.notify(`Profile "${name}" already exists. Use /profile edit ${name} to modify it.`, "warning");
          return;
        }
        await editProfileInteractive(name, {}, ctx);
        return;
      }

      // ── /profile edit <name> ──
      if (sub === "edit") {
        const name = tokens[1];
        if (!name) {
          ctx.ui.notify("Usage: /profile edit <name>", "warning");
          return;
        }
        const profiles = await loadProfiles(ctx.cwd);
        const profile = profiles[name];
        if (!profile) {
          ctx.ui.notify(`Profile "${name}" not found. Use /profile create ${name} to create it.`, "error");
          return;
        }
        await editProfileInteractive(name, { ...profile }, ctx);
        return;
      }

      // ── /profile delete <name> ──
      if (sub === "delete" || sub === "rm" || sub === "remove") {
        const name = tokens[1];
        if (!name) {
          ctx.ui.notify("Usage: /profile delete <name>", "warning");
          return;
        }
        const ok = await ctx.ui.confirm("Delete profile?", `Delete subagent profile "${name}"?`);
        if (!ok) return;
        const deleted = await deleteProfile(name, "global");
        const deletedProject = await deleteProfile(name, "project", ctx.cwd);
        if (deleted || deletedProject) {
          ctx.ui.notify(`Profile "${name}" deleted.`, "info");
        } else {
          ctx.ui.notify(`Profile "${name}" not found.`, "error");
        }
        return;
      }

      // ── Bare name: /profile <name> (alias for show) ──
      if (sub && !/^(list|show|create|edit|delete|ls|new|rm|remove)$/.test(sub)) {
        const profiles = await loadProfiles(ctx.cwd);
        const profile = profiles[sub];
        if (profile) {
          ctx.ui.notify(formatProfileDetail(sub, profile), "info");
          return;
        }
      }

      ctx.ui.notify(
        "Usage: /profile [list|show <name>|create <name>|edit <name>|delete <name>]",
        "warning",
      );
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

function getSummaryText(windows: SubAgentWindow[]): string {
  const running = windows.filter((w) => w.status === "running").length;
  const done = windows.filter((w) => w.status === "completed").length;
  const errors = windows.filter((w) => w.status === "error").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (done > 0) parts.push(`${done} done`);
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  return parts.join(", ") || "processing...";
}
