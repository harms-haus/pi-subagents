/**
 * Delegate to Sub-agents Tool
 *
 * Tool registration for spawning parallel sub-agents to work on separate tasks.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import {
  loadExtendTimeoutDebounce,
  loadLoopingToolCount,
  loadMaxLinesPerWindow,
} from "../settings";
import { runSubAgent } from "../spawner";
import {
  DEFAULT_TIMEOUT,
  formatRunsForResume,
  LOOP_DETECTED_MESSAGE,
  MAX_CONCURRENCY,
} from "../types";
import { getSummaryText, mapWithConcurrencyLimit } from "../utils";
import { renderDelegateCall, renderDelegateResult } from "./delegate-render";
import type { SubagentProfile } from "../profile-types";
import type {
  FileSpec,
  SessionRecord,
  SubAgentWindow,
  SubagentSessionData,
  WindowedSubagentDetails,
} from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Read a file and return its formatted contents for prompt injection.
 * Returns `[file not found: <path>]` if the file doesn't exist or can't be read.
 * Line numbers are 1-indexed and inclusive.
 */
function readFileContents(spec: FileSpec, cwd: string): string {
  const path = typeof spec === "string" ? spec : spec.path;
  const absolutePath = resolve(cwd, path);

  if (!existsSync(absolutePath)) {
    return `[file not found: ${path}]`;
  }

  // Check file size before reading
  const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB
  try {
    const stat = statSync(absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      return `[file too large: ${path} (${Math.round(stat.size / 1024)}KB, limit ${MAX_FILE_BYTES / 1024}KB)]`;
    }
  } catch {
    return `[could not read file: ${path}]`;
  }

  let contents: string;
  try {
    contents = readFileSync(absolutePath, "utf-8");
  } catch {
    return `[could not read file: ${path}]`;
  }

  let lines = contents.split("\n");

  // Strip trailing empty line from newline-terminated files (before slicing)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  // Apply line slicing based on spec type
  if (typeof spec !== "string") {
    if ("tail" in spec) {
      lines = spec.tail > 0 ? lines.slice(-spec.tail) : [];
    } else if ("head" in spec) {
      lines = spec.head > 0 ? lines.slice(0, spec.head) : [];
    } else {
      const start = spec.start ?? 1;
      const end = spec.end ?? lines.length;
      lines = lines.slice(start - 1, end);
    }
  }

  return `=== ${path} ===\n${lines.join("\n")}`;
}

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
      "parameter (in seconds, default 600). Timeouts auto-extend while the sub-agent is active — the",
      "sub-agent is only killed after it goes idle past the timeout (configurable via settings).",
      "Each task supports an optional `resume` parameter referencing a previous session",
      "ID. The resumed agent receives the prior session's transcript as context.",
      "Each task supports an optional `files` parameter — an array of file paths or file spec",
      "objects to read and prepend to the prompt. Accepts strings, { path, start?, end? }",
      "for line ranges, { path, tail: N } for the last N lines, or { path, head: N } for",
      "the first N lines. Missing, unreadable, or oversized files produce a descriptive placeholder instead of failing.",
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
      "Timeouts auto-extend while the sub-agent is actively producing output.\n",
      "Use the `resume` parameter to continue work from a previous sub-agent session.\n",
      "You can only resume sessions that are completed or errored (not running).\n",
      "Use the `files` parameter to provide file context to sub-agents without embedding large file contents directly in the prompt string.\n",
    ],

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const [maxLines, extendDebounce, loopingToolCount] = await Promise.all([
        loadMaxLinesPerWindow(ctx.cwd),
        loadExtendTimeoutDebounce(ctx.cwd),
        loadLoopingToolCount(ctx.cwd),
      ]);

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
      let skillMap:
        | Map<string, { filePath: string; name: string; description: string }>
        | undefined;
      const needsSkillResolution = resolvedProfiles.some(
        ({ profile }) => profile && (profile.suggestedSkills?.length || profile.loadSkills?.length),
      );
      if (needsSkillResolution) {
        const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
        const discResult = discoverSkills({
          cwd: ctx.cwd,
          agentDir,
          skillPaths: [],
          includeDefaults: true,
        });
        skillMap = new Map(discResult.skills.map((s) => [s.name, s]));
      }

      // Pre-resolve skills for each unique profile to avoid repeated file reads (E1+E2)
      const skillResolvedProfiles = new Map<
        SubagentProfile,
        { ok: true; profile: SubagentProfile } | { ok: false; error: string }
      >();
      for (const { profile } of resolvedProfiles) {
        if (
          profile &&
          !skillResolvedProfiles.has(profile) &&
          (profile.suggestedSkills?.length || profile.loadSkills?.length)
        ) {
          try {
            skillResolvedProfiles.set(profile, {
              ok: true,
              profile: resolveProfileSkills(profile, ctx.cwd, skillMap),
            });
          } catch (skillError) {
            skillResolvedProfiles.set(profile, {
              ok: false,
              error: skillError instanceof Error ? skillError.message : String(skillError),
            });
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
            resolvedProfile && resolvedProfileName
              ? profileSummary(resolvedProfileName, resolvedProfile)
              : undefined,
          provider: resolvedProfile?.provider,
          model: resolvedProfile?.model,
          thinkingLevel: resolvedProfile?.thinkingLevel,
          startedAt: Date.now(),
          timeout: t.timeout ?? DEFAULT_TIMEOUT,
          todoTotal: undefined,
          todoCompleted: undefined,
          toolCount: resolvedProfile?.noTools
            ? 0
            : (resolvedProfile?.tools?.length ?? allToolNames?.length ?? 0),
          recentToolCalls: [],
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
        if (windows.some((w) => w.status === "running")) {
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

          // Prepend file contents if specified
          if (task.files && task.files.length > 0) {
            const fileCwd = task.cwd ?? ctx.cwd;
            const fileBlocks = task.files.map((spec) => readFileContents(spec, fileCwd));
            effectivePrompt = `${fileBlocks.join("\n\n")}\n\n${effectivePrompt}`;
          }

          const effectiveTask = { ...task, prompt: effectivePrompt };

          // Create per-task timeout
          const taskTimeout = Math.max(1, task.timeout ?? DEFAULT_TIMEOUT);
          const taskAbortController = new AbortController();

          // Idle-timer approach for timeout extension:
          // The idle timer starts immediately and resets on every activity.
          // When it fires (after extendDebounce seconds of no activity), it checks
          // whether total elapsed time >= taskTimeout. Only then does it abort.
          let idleTimer: ReturnType<typeof setTimeout> | null = null;

          const startIdleTimer = () => {
            idleTimer = setTimeout(
              () => {
                if (Date.now() - win.startedAt >= taskTimeout * 1000) {
                  taskAbortController.abort();
                } else {
                  // Reschedule for the remaining time to ensure timeout is enforced
                  // even if no activity occurs to restart the idle timer.
                  const remaining = Math.max(taskTimeout * 1000 - (Date.now() - win.startedAt), 1);
                  idleTimer = setTimeout(() => {
                    taskAbortController.abort();
                  }, remaining);
                }
              },
              extendDebounce * 1000 || 1,
            );
          };

          // Start the idle timer immediately
          startIdleTimer();

          // Reset idle timer on activity (called by wrappedEmitUpdate)
          const resetIdleTimer = () => {
            if (idleTimer) {
              clearTimeout(idleTimer);
            }
            startIdleTimer();
          };

          // Forward parent signal to task controller
          const onParentAbort = () => {
            taskAbortController.abort();
          };
          if (signal?.aborted) {
            taskAbortController.abort();
          } else if (signal) {
            signal.addEventListener("abort", onParentAbort, { once: true });
          }

          // Wrap emitUpdate to reset idle timer on any output activity
          const wrappedEmitUpdate = () => {
            emitUpdate();
            resetIdleTimer();
          };

          // eslint-disable-next-line no-useless-assignment
          let loopDetected = false;

          try {
            const result = await runSubAgent({
              task: effectiveTask,
              win,
              maxLines,
              signal: taskAbortController.signal,
              onUpdate: wrappedEmitUpdate,
              session,
              profile: skillResolvedProfile,
              loopingToolCount,
            });
            loopDetected = result.loopDetected;
          } finally {
            if (idleTimer) {
              clearTimeout(idleTimer);
            }
            if (signal) {
              signal.removeEventListener("abort", onParentAbort);
            }
          }

          // Handle loop detection kill
          if (loopDetected) {
            win.status = "error";
            session.status = "error";
            win.errorMessage = LOOP_DETECTED_MESSAGE;
            session.errorMessage = LOOP_DETECTED_MESSAGE;
            win.exitCode = 1;
            session.exitCode = 1;
            win.completedAt = Date.now();
            taskAbortController.abort();
            emitUpdate();
          }

          // Check if timeout caused the abort (not loop detection, not parent abort)
          if (!loopDetected && taskAbortController.signal.aborted && !signal?.aborted) {
            win.status = "error";
            session.status = "error";
            const elapsedSeconds = Math.round((Date.now() - win.startedAt) / 1000);
            win.errorMessage = `Timed out after ${elapsedSeconds}s. Consider resuming with a longer timeout.`;
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
