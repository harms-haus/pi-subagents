/**
 * Delegate to Sub-agents Tool
 *
 * Tool registration for spawning parallel sub-agents to work on separate tasks.
 */

import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { loadMaxLinesPerWindow, loadProfiles, profileSummary, resolveProfile } from "../profiles";
import { DelegateParams } from "../schemas";
import { runSubAgent } from "../spawner";
import type { SubAgentWindow, SubagentSessionData, WindowedSubagentDetails } from "../types";
import { MAX_CONCURRENCY } from "../types";
import { countWindowStatuses, getSummaryText, mapWithConcurrencyLimit } from "../utils";

// WindowLine is defined in types.ts but needed for renderResult
type WindowLine = {
  text: string;
  kind: "text" | "tool";
};

/**
 * Register the delegate_to_subagents tool.
 */
export function registerDelegateTool(
  pi: ExtensionAPI,
  _sessionStore: Map<string, SubagentSessionData>,
  registerSession: (session: SubagentSessionData) => void,
): void {
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
      "Returns session IDs for each task that can be used with get_subagent_output",
      "and get_subagent_session to retrieve results.",
    ].join(" "),
    parameters: DelegateParams,
    promptSnippet: "Use when the user wants multiple independent tasks done in parallel",
    promptGuidelines: [
      "Use delegate_to_subagents when the user asks for multiple independent tasks.\n",
      "Each task gets its own isolated pi sub-agent process with full tool access.\n",
      "Provide a descriptive `name` for each task so the TUI window is labeled.\n",
      "Use the `profile` parameter (top-level or per-task) to select a named subagent profile",
      "that pre-configures provider/model, system prompt, thinking level, and other settings.\n",
      'When the user mentions a specific agent role like "use the code-reviewer profile"',
      'or "run this as the researcher", set the profile field accordingly.\n',
      "After delegate_to_subagents completes, use get_subagent_output to retrieve each sub-agent's",
      "final text output. Use get_subagent_session for the full session transcript if needed.\n",
    ],

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const maxLines = await loadMaxLinesPerWindow(ctx.cwd);

      // Load profiles from settings (global + project-local)
      const profiles = await loadProfiles(ctx.cwd);

      // Pre-resolve profiles for each task (avoids double resolution)
      const resolvedProfiles = params.tasks.map((t) => {
        const name = t.profile ?? params.profile;
        const profile = name ? resolveProfile(profiles, name) : undefined;
        return { name, profile };
      });

      const windows: SubAgentWindow[] = params.tasks.map((t, i) => {
        const resolvedProfileName = resolvedProfiles[i].name;
        const resolvedProfile = resolvedProfiles[i].profile;
        const sessionId = randomUUID().replace(/-/g, "").slice(0, 16);

        return {
          name: t.name,
          sessionId,
          status: "running",
          lines: [],
          allMessages: [],
          exitCode: null,
          profileName: resolvedProfileName,
          profileInfo:
            resolvedProfile && resolvedProfileName ? profileSummary(resolvedProfileName, resolvedProfile) : undefined,
        };
      });

      // Create session data for each task
      const sessions: SubagentSessionData[] = params.tasks.map((t, i) => ({
        sessionId: windows[i].sessionId,
        taskName: t.name,
        prompt: t.prompt,
        cwd: t.cwd,
        profileName: t.profile ?? params.profile,
        status: "running" as const,
        messages: [],
        exitCode: null,
        startedAt: Date.now(),
      }));

      // Register sessions in the store
      for (const session of sessions) {
        registerSession(session);
      }

      const makeDetails = (): WindowedSubagentDetails => ({
        windows,
        maxLinesPerWindow: maxLines,
        globalStatus: windows.every((w) => w.status !== "running") ? "done" : "running",
        sessionIds: windows.map((w) => w.sessionId),
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
        const session = sessions[index];
        const resolvedProfileName = resolvedProfiles[index].name;
        const resolvedProfile = resolvedProfiles[index].profile;

        if (resolvedProfileName && !resolvedProfile) {
          win.status = "error";
          session.status = "error";
          win.errorMessage = `Unknown profile: "${resolvedProfileName}". Available profiles: ${Object.keys(profiles).join(", ") || "(none)"}`;
          session.errorMessage = win.errorMessage;
          win.exitCode = 1;
          session.exitCode = 1;
          emitUpdate();
          return;
        }

        await runSubAgent({
          task,
          win,
          maxLines,
          signal,
          onUpdate: emitUpdate,
          session,
          profile: resolvedProfile,
        });
      });

      const summaryLines: string[] = [];
      for (const win of windows) {
        const icon = win.status === "completed" ? "✓" : "✗";
        let line = `${icon} ${win.name}: ${win.status} (session: ${win.sessionId})`;
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
      const taskProfiles = (args.tasks ?? []).map((t: { profile?: string }) => t.profile).filter(Boolean) as string[];
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
    renderResult(result, { isPartial: _isPartial, expanded: _expanded }, theme, _context) {
      const details = result.details as WindowedSubagentDetails | undefined;
      if (!details) {
        return new Text("(no sub-agent details)", 0, 0);
      }

      const container = new Container();
      const { running, completed: done, error: errors } = countWindowStatuses(details.windows);

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
        const icon = win.status === "running" ? "⏳" : win.status === "error" ? "✗" : "✓";
        const color = win.status === "running" ? "warning" : win.status === "error" ? "error" : "success";

        let headerLine = `${theme.fg(color, icon)} ${theme.fg("accent", theme.bold(win.name))}`;
        if (win.profileName) {
          headerLine += theme.fg("dim", ` [${win.profileInfo ?? win.profileName}]`);
        }
        container.addChild(new Text(headerLine, 0, 0));

        const renderLine = (entry: WindowLine) => {
          const textLines = entry.text.split("\n");
          for (const line of textLines) {
            if (entry.kind === "tool") {
              container.addChild(new Text(`  ${theme.fg("muted", line)}`, 0, 0));
            } else {
              container.addChild(new Text(`  ${line}`, 0, 0));
            }
          }
        };

        if (_expanded) {
          // Expanded (Ctrl+O): show all captured messages, not just latest N
          if (win.allMessages.length === 0) {
            container.addChild(new Text(theme.fg("muted", "  (no output)"), 0, 0));
          } else {
            for (const entry of win.allMessages) {
              renderLine(entry);
            }
          }
        } else {
          // Collapsed: rolling window (latest N lines)
          if (win.lines.length === 0) {
            container.addChild(new Text(theme.fg("muted", "  (starting...)"), 0, 0));
          } else {
            for (const entry of win.lines) {
              renderLine(entry);
            }
          }
        }

        if (win.status === "error" && win.errorMessage) {
          container.addChild(new Text(theme.fg("error", `  Error: ${win.errorMessage}`), 0, 0));
        }

        container.addChild(new Spacer(1));
      }

      // ── Footer: session IDs when done ──
      if (running > 0) {
        container.addChild(new Text(theme.fg("muted", `${running} running...`), 0, 0));
      } else {
        // Show session IDs for retrieval
        const idLines = details.windows.map((w) => `  ${w.name}: ${theme.fg("accent", w.sessionId)}`);
        container.addChild(new Text(theme.fg("dim", "Session IDs (use with get_subagent_output):"), 0, 0));
        for (const line of idLines) {
          container.addChild(new Text(`  ${line}`, 0, 0));
        }
      }

      return container;
    },
  });
}
