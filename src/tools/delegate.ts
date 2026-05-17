/**
 * Delegate to Sub-agents Tool
 *
 * Tool registration for spawning parallel sub-agents to work on separate tasks.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSkills as discoverSkills } from "@earendil-works/pi-coding-agent";
import {
  applyExcludeTools,
  loadProfiles,
  profileSummary,
  resolveProfile,
  resolveProfileSkills,
  validateProfileTools,
  validateProfileSkills,
} from "../profiles";
import { DelegateParams } from "../schemas";
import { loadMaxLinesPerWindow } from "../settings";
import { runSubAgent } from "../spawner";
import { DEFAULT_TIMEOUT, formatRunsForResume, MAX_CONCURRENCY } from "../types";
import { getSummaryText, mapWithConcurrencyLimit } from "../utils";
import { renderDelegateCall, renderDelegateResult } from "./delegate-render";
import type { SubagentProfile } from "../profile-types";
import type { SessionRecord, SubAgentWindow, SubagentSessionData, WindowedSubagentDetails } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Register the delegate_to_subagents tool.
 */
export function registerDelegateTool(
  pi: ExtensionAPI,
  sessionStore: Map<string, SessionRecord>,
  registerSession: (session: SubagentSessionData) => void,
  getActiveSessionIds: () => Set<string>,
): void {
  pi.registerTool({
    name: "delegate_to_subagents",
    label: "Delegate to Sub-agents",
    description: [
      "Spawn one or more parallel sub-agents to work on separate tasks.",
      "Each sub-agent runs in an isolated pi process with its own context window.",
      "Live progress from each sub-agent is shown in a rolling window in the TUI.",
      "Optionally specify a profile name to pre-configure provider/model, system prompt,",
      "thinking level, and other model settings. Profiles are defined as individual .md files",
      "in ~/.pi/agent/agent-profiles/ (global) or .pi/agent-profiles/ (project-local). A top-level profile parameter sets a default for all tasks;",
      "each task can override with its own profile.",
      "Returns session IDs for each task that can be used with get_subagent_output",
      "and get_subagent_session to retrieve results. Each task supports an optional `timeout`",
      "parameter (in seconds, default 600) that aborts the sub-agent if it exceeds the time",
      "limit. Each task supports an optional `resume` parameter referencing a previous session",
      "ID. The resumed agent receives the prior session's transcript as context.",
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
      "Use the `timeout` per-task parameter to set a time limit in seconds. Default is 600s (10 min).\n",
      "Use the `resume` parameter to continue work from a previous sub-agent session.\n",
      "You can only resume sessions that are completed or errored (not running).\n",
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

      // Resolve excludeTools: validate and compute tool allowlists
      let allToolNames: string[] | undefined;
      for (let i = 0; i < resolvedProfiles.length; i++) {
        const { name, profile } = resolvedProfiles[i];
        if (profile?.excludeTools && profile.excludeTools.length > 0) {
          if (!allToolNames) {
            allToolNames = pi.getAllTools().map((t) => t.name);
          }
          validateProfileTools(profile, name);
          resolvedProfiles[i] = { name, profile: applyExcludeTools(profile, allToolNames) };
        }
      }

      // Validate skills in profiles
      for (const { name, profile } of resolvedProfiles) {
        if (profile) {
          validateProfileSkills(profile, name);
        }
      }

      // Cache skill discovery: call discoverSkills once if any profile needs skill resolution
      let skillMap: Map<string, { filePath: string; name: string; description: string }> | undefined;
      const needsSkillResolution = resolvedProfiles.some(
        ({ profile }) => profile && (profile.suggestedSkills?.length || profile.loadSkills?.length),
      );
      if (needsSkillResolution) {
        const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
        const discResult = discoverSkills({ cwd: ctx.cwd, agentDir, skillPaths: [], includeDefaults: true });
        skillMap = new Map(discResult.skills.map((s) => [s.name, s]));
      }

      // Pre-resolve skills for each unique profile to avoid repeated file reads (E1+E2)
      const skillResolvedProfiles = new Map<SubagentProfile, { ok: true; profile: SubagentProfile } | { ok: false; error: string }>();
      for (const { profile } of resolvedProfiles) {
        if (profile && !skillResolvedProfiles.has(profile) && (profile.suggestedSkills?.length || profile.loadSkills?.length)) {
          try {
            skillResolvedProfiles.set(profile, { ok: true, profile: resolveProfileSkills(profile, ctx.cwd, skillMap) });
          } catch (skillError) {
            skillResolvedProfiles.set(profile, { ok: false, error: skillError instanceof Error ? skillError.message : String(skillError) });
          }
        }
      }

      // Validate resume parameters
      const activeIds = getActiveSessionIds();
      for (const task of params.tasks) {
        if (task.resume) {
          const record = sessionStore.get(task.resume);
          if (!record || record.runs.length === 0) {
            throw new Error(
              `Cannot resume: session "${task.resume}" not found. The session may have expired or the ID is incorrect.`,
            );
          }
          if (activeIds.has(task.resume)) {
            throw new Error(
              `Cannot resume: session "${task.resume}" is still running. Wait for it to complete before resuming.`,
            );
          }
        }
      }

      const windows: SubAgentWindow[] = params.tasks.map((t, i) => {
        const resolvedProfileName = resolvedProfiles[i].name;
        const resolvedProfile = resolvedProfiles[i].profile;
        const sessionId = t.resume || randomUUID().replace(/-/g, "").slice(0, 16);

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
          provider: resolvedProfile?.provider,
          model: resolvedProfile?.model,
          thinkingLevel: resolvedProfile?.thinkingLevel,
          startedAt: Date.now(),
          timeout: t.timeout ?? DEFAULT_TIMEOUT,
          todoTotal: undefined,
          todoCompleted: undefined,
          toolCount: resolvedProfile?.noTools
            ? 0
            : resolvedProfile?.tools?.length ?? allToolNames?.length ?? 0,
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

      const timerInterval = setInterval(() => {
        if (windows.some(w => w.status === "running")) {
          emitUpdate();
        }
      }, 1000);

      try {
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

        // Look up pre-resolved skills for this profile (resolved once per unique profile above)
        let skillResolvedProfile = resolvedProfile;
        if (resolvedProfile?.suggestedSkills?.length || resolvedProfile?.loadSkills?.length) {
          const result = skillResolvedProfiles.get(resolvedProfile);
          if (!result || !result.ok) {
            win.status = "error";
            session.status = "error";
            win.errorMessage = result?.error ?? "Skill resolution failed";
            session.errorMessage = win.errorMessage;
            win.exitCode = 1;
            session.exitCode = 1;
            emitUpdate();
            return;
          }
          skillResolvedProfile = result.profile;
        }

        // Format prompt for resume if applicable
        let effectivePrompt = task.prompt;
        if (task.resume) {
          const record = sessionStore.get(task.resume);
          if (record) {
            const previousData = formatRunsForResume(record.runs);
            effectivePrompt = `Previously:\n\n${previousData}\n\nInstructions:\n\n${task.prompt}`;
          }
        }

        const effectiveTask = { ...task, prompt: effectivePrompt };

        // Create per-task timeout
        const taskTimeout = Math.max(1, task.timeout ?? DEFAULT_TIMEOUT);
        const taskAbortController = new AbortController();
        const taskAbortTimeout = setTimeout(() => {
          taskAbortController.abort();
        }, taskTimeout * 1000);

        // Forward parent signal to task controller
        const onParentAbort = () => taskAbortController.abort();
        if (signal?.aborted) {
          taskAbortController.abort();
        } else if (signal) {
          signal.addEventListener("abort", onParentAbort, { once: true });
        }

        try {
          await runSubAgent({
            task: effectiveTask,
            win,
            maxLines,
            signal: taskAbortController.signal,
            onUpdate: emitUpdate,
            session,
            profile: skillResolvedProfile,
          });
        } finally {
          clearTimeout(taskAbortTimeout);
          if (signal) {signal.removeEventListener("abort", onParentAbort);}
        }

        // Check if timeout caused the abort
        if (taskAbortController.signal.aborted && !signal?.aborted) {
          win.status = "error";
          session.status = "error";
          win.errorMessage = `Timed out after ${taskTimeout}s. Consider resuming with a longer timeout.`;
          session.errorMessage = win.errorMessage;
          win.exitCode = 1;
          session.exitCode = 1;
          win.completedAt = Date.now();
          emitUpdate();
        }
      });
      } finally {
        clearInterval(timerInterval);
      }

      const summaryLines: string[] = [];
      for (const win of windows) {
        const icon = win.status === "completed" ? "✓" : "✗";
        let line = `${icon} ${win.name}: ${win.status} (session: ${win.sessionId})`;
        if (win.errorMessage) {
          line += ` — ${win.errorMessage}`;
        }
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
    renderCall: renderDelegateCall,

    // ── renderResult: Live rolling window display ──────────────────
    renderResult: renderDelegateResult,
  });
}
