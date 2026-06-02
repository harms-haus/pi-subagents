/**
 * Delegate to Sub-agents Tool
 *
 * Tool registration for spawning parallel sub-agents to work on separate tasks.
 */

import { randomUUID } from "node:crypto";
import { DelegateParams } from "../schemas";
import {
  loadExtendTimeoutDebounce,
  loadLoopingToolCount,
  loadMaxLinesPerWindow,
} from "../settings";
import {
  CUSTOM_ENTRY_TYPE,
  DEFAULT_TIMEOUT,
  MAX_CONCURRENCY,
  serializeSessionData,
} from "../types";
import { getSummaryText, mapWithConcurrencyLimit } from "../utils";
import { renderDelegateCall, renderDelegateResult } from "./delegate-render";
import { resolveTaskProfiles } from "./delegate-profiles";
import { runSingleTask } from "./delegate-runner";
import { profileSummary } from "../profiles";
import type { ResolvedProfileEntry, StaticDelegateParams } from "./delegate-types";
import type { SubagentProfile } from "../profile-types";
import type {
  SessionRecord,
  SubAgentWindow,
  SubagentSessionData,
  WindowedSubagentDetails,
} from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Re-export types for backward compatibility — tests import these from this module
export type { ResolvedProfileEntry, StaticDelegateParams, TaskRunContext } from "./delegate-types";

// ── Resume Validation ─────────────────────────────────────────────────

/**
 * Validate resume parameters for all tasks.
 * Throws if any task references a non-existent or still-running session.
 */
function validateResumeParams(
  tasks: StaticDelegateParams["tasks"],
  sessionStore: Map<string, SessionRecord>,
  getActiveSessionIds: () => Set<string>,
): void {
  const activeIds = getActiveSessionIds();
  for (const task of tasks) {
    if (!task.resume) continue;
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

// ── Window & Session Creation ─────────────────────────────────────────

/**
 * Compute profile display info string, or undefined if no profile.
 */
function computeProfileInfo(
  name: string | undefined,
  profile: SubagentProfile | undefined,
): string | undefined {
  if (profile && name) return profileSummary(name, profile);
  return undefined;
}

/**
 * Compute the number of tools available for a sub-agent window.
 */
function computeToolCount(
  profile: SubagentProfile | undefined,
  allToolNames: string[] | undefined,
): number {
  if (profile?.noTools) return 0;
  return profile?.tools?.length ?? allToolNames?.length ?? 0;
}

/**
 * Create a SubAgentWindow for a single task.
 */
function createTaskWindow(
  task: StaticDelegateParams["tasks"][number],
  rp: ResolvedProfileEntry,
  allToolNames: string[] | undefined,
): SubAgentWindow {
  const sessionId = task.resume || randomUUID().replace(/-/g, "").slice(0, 16);

  return {
    name: task.name,
    sessionId,
    status: "running",
    lines: [],
    allMessages: [],
    exitCode: null,
    profileName: rp.name,
    profileInfo: computeProfileInfo(rp.name, rp.profile),
    provider: rp.profile?.provider,
    model: rp.profile?.model,
    thinkingLevel: rp.profile?.thinkingLevel,
    startedAt: Date.now(),
    timeout: task.timeout ?? DEFAULT_TIMEOUT,
    todoTotal: undefined,
    todoCompleted: undefined,
    toolCount: computeToolCount(rp.profile, allToolNames),
    fileCount: task.files?.length ?? 0,
    recentToolCalls: [],
  };
}

/**
 * Create SubAgentWindows for all tasks in a delegation request.
 */
function createTaskWindows(
  tasks: StaticDelegateParams["tasks"],
  resolvedProfiles: ResolvedProfileEntry[],
  allToolNames: string[] | undefined,
): SubAgentWindow[] {
  return tasks.map((t, i) => {
    const rp = resolvedProfiles[i];
    return rp ? createTaskWindow(t, rp, allToolNames) : createTaskWindow(t, {}, allToolNames);
  });
}

/**
 * Create a SubagentSessionData for a single task.
 */
function createTaskSession(
  task: StaticDelegateParams["tasks"][number],
  window: SubAgentWindow,
  defaultProfile?: string,
): SubagentSessionData {
  return {
    sessionId: window.sessionId,
    taskName: task.name,
    prompt: task.prompt,
    cwd: task.cwd,
    profileName: task.profile ?? defaultProfile,
    status: "running" as const,
    messages: [],
    exitCode: null,
    startedAt: Date.now(),
  };
}

// ── Summary Building ──────────────────────────────────────────────────

/**
 * Build summary lines for all completed sub-agent windows.
 */
function buildSummaryLines(windows: SubAgentWindow[]): string[] {
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
  return summaryLines;
}

// ── Tool Registration ─────────────────────────────────────────────────

/**
 * Persist session data to the main agent's session tree.
 */
function persistSession(pi: ExtensionAPI, session: SubagentSessionData): void {
  try {
    pi.appendEntry(CUSTOM_ENTRY_TYPE, serializeSessionData(session));
  } catch (err) {
    // Persistence should never break delegation
    console.warn("[pi-subagents] Failed to persist session data:", err);
  }
}

/**
 * Execute the delegate_to_subagents tool: resolve profiles, create windows/sessions,
 * run tasks in parallel with concurrency limiting, and return results.
 */
async function executeDelegate(
  pi: ExtensionAPI,
  sessionStore: Map<string, SessionRecord>,
  registerSession: (session: SubagentSessionData) => void,
  getActiveSessionIds: () => Set<string>,
  _params: StaticDelegateParams,
  signal: AbortSignal | undefined,
  onUpdate:
    | ((update: {
        content: Array<{ type: "text"; text: string }>;
        details: WindowedSubagentDetails | undefined;
      }) => void)
    | undefined,
  ctx: { cwd: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WindowedSubagentDetails }> {
  const [maxLines, extendDebounce, loopingToolCount] = await Promise.all([
    loadMaxLinesPerWindow(ctx.cwd),
    loadExtendTimeoutDebounce(ctx.cwd),
    loadLoopingToolCount(ctx.cwd),
  ]);

  const { profiles, resolvedProfiles, skillResolvedProfiles, allToolNames, agentDir } =
    await resolveTaskProfiles(_params, ctx.cwd, pi);

  validateResumeParams(_params.tasks, sessionStore, getActiveSessionIds);

  const windows = createTaskWindows(_params.tasks, resolvedProfiles, allToolNames);
  const sessions = _params.tasks.map((t, i) => {
    const win = windows[i] ?? windows[0];
    if (!win) throw new Error("No window available for task");
    return createTaskSession(t, win, _params.profile);
  });

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
    await mapWithConcurrencyLimit(_params.tasks, MAX_CONCURRENCY, async (task, index) => {
      const win = windows[index];
      const session = sessions[index];
      const rp = resolvedProfiles[index];
      if (!win || !session || !rp) return;

      await runSingleTask(task, {
        win,
        session,
        rp: rp,
        profiles,
        skillResolvedProfiles,
        sessionStore,
        taskCwd: ctx.cwd,
        maxLines,
        loopingToolCount,
        agentDir,
        extendDebounce,
        emitUpdate,
        persistSession: (s) => {
          persistSession(pi, s);
        },
        parentSignal: signal,
      });
    });
  } finally {
    clearInterval(timerInterval);
  }

  return {
    content: [{ type: "text", text: buildSummaryLines(windows).join("\n") }],
    details: makeDetails(),
  };
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
      return executeDelegate(
        pi,
        sessionStore,
        registerSession,
        getActiveSessionIds,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },

    // ── renderCall ─────────────────────────────────────────────────
    renderCall: renderDelegateCall,

    // ── renderResult: Live rolling window display ──────────────────
    renderResult: renderDelegateResult,
  });
}
