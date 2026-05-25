/**
 * Delegate to Sub-agents Tool
 *
 * Tool registration for spawning parallel sub-agents to work on separate tasks.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
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
import { resolvePackageSkillPaths } from "../skill-discovery";
import { runSubAgent } from "../spawner";
import {
  CUSTOM_ENTRY_TYPE,
  DEFAULT_TIMEOUT,
  formatRunsForResume,
  LOOP_DETECTED_MESSAGE,
  MAX_CONCURRENCY,
  serializeSessionData,
} from "../types";
import type { SubAgentTask } from "../types";
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

// ── File Reading ──────────────────────────────────────────────────────

/** Inferred type from the DelegateParams schema */
type StaticDelegateParams = {
  tasks: SubAgentTask[];
  profile?: string;
};

/** Resolved profile data for a single task */
type ResolvedProfileEntry = { name?: string; profile?: SubagentProfile };

/**
 * Apply line slicing to file contents based on a FileSpec.
 * Returns the sliced lines as-is if the spec is a plain string path.
 */
function sliceLines(lines: string[], spec: FileSpec): string[] {
  if (typeof spec === "string") return lines;
  if ("tail" in spec) return spec.tail > 0 ? lines.slice(-spec.tail) : [];
  if ("head" in spec) return spec.head > 0 ? lines.slice(0, spec.head) : [];
  return lines.slice((spec.start ?? 1) - 1, spec.end ?? lines.length);
}

/**
 * Read a file and return its formatted contents for prompt injection.
 * Returns `[file not found: <path>]` if the file doesn't exist or can't be read.
 * Line numbers are 1-indexed and inclusive.
 */
async function readFileContents(spec: FileSpec, cwd: string): Promise<string> {
  const path = typeof spec === "string" ? spec : spec.path;
  const absolutePath = resolve(cwd, path);

  // Prevent path traversal outside cwd
  const resolvedCwd = resolve(cwd);
  if (absolutePath !== resolvedCwd && !absolutePath.startsWith(resolvedCwd + sep)) {
    return `[access denied: path outside project directory: ${path}]`;
  }

  // Check file size before reading
  const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return `[file too large: ${path} (${Math.round(fileStat.size / 1024)}KB, limit ${MAX_FILE_BYTES / 1024}KB)]`;
    }
  } catch {
    return `[file not found: ${path}]`;
  }

  let contents: string;
  try {
    contents = await readFile(absolutePath, "utf-8");
  } catch {
    return `[could not read file: ${path}]`;
  }

  let lines = contents.split("\n");

  // Strip trailing empty line from newline-terminated files (before slicing)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  lines = sliceLines(lines, spec);

  return `=== ${path} ===\n${lines.join("\n")}`;
}

// ── Profile Resolution ────────────────────────────────────────────────

/**
 * Apply tool exclude lists to resolved profiles.
 * Returns the list of all tool names (lazily computed).
 */
function applyToolExcludeLists(
  resolvedProfiles: ResolvedProfileEntry[],
  pi: ExtensionAPI,
): string[] | undefined {
  let allToolNames: string[] | undefined;
  for (let i = 0; i < resolvedProfiles.length; i++) {
    const entry = resolvedProfiles[i];
    if (!entry) continue;
    const { name, profile } = entry;
    if (profile?.excludeTools && profile.excludeTools.length > 0) {
      if (!allToolNames) {
        allToolNames = pi.getAllTools().map((t) => t.name);
      }
      validateProfileTools(profile, name);
      resolvedProfiles[i] = { name, profile: applyExcludeTools(profile, allToolNames) };
    }
  }
  return allToolNames;
}

/**
 * Discover skills if any profile needs skill resolution.
 * Returns a skill map keyed by skill name, or undefined if no resolution needed.
 */
async function discoverSkillsIfNeeded(
  resolvedProfiles: ResolvedProfileEntry[],
  cwd: string,
  agentDir: string,
): Promise<Map<string, { filePath: string; name: string; description: string }> | undefined> {
  const needsSkillResolution = resolvedProfiles.some(
    ({ profile }) => profile && (profile.suggestedSkills?.length || profile.loadSkills?.length),
  );
  if (!needsSkillResolution) return undefined;

  const packageSkillPaths = await resolvePackageSkillPaths(cwd, agentDir);
  const discResult = discoverSkills({
    cwd,
    agentDir,
    skillPaths: packageSkillPaths,
    includeDefaults: true,
  });
  return new Map(discResult.skills.map((s) => [s.name, s]));
}

/**
 * Pre-resolve skills for each unique profile to avoid repeated file reads.
 */
async function preResolveProfileSkills(
  resolvedProfiles: ResolvedProfileEntry[],
  cwd: string,
  skillMap: Map<string, { filePath: string; name: string; description: string }> | undefined,
): Promise<
  Map<SubagentProfile, { ok: true; profile: SubagentProfile } | { ok: false; error: string }>
> {
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
          profile: await resolveProfileSkills(profile, cwd, skillMap),
        });
      } catch (skillError) {
        skillResolvedProfiles.set(profile, {
          ok: false,
          error: skillError instanceof Error ? skillError.message : String(skillError),
        });
      }
    }
  }
  return skillResolvedProfiles;
}

/** Result of resolving all task profiles, skills, and tool allowlists */
interface ProfileResolutionResult {
  profiles: Record<string, SubagentProfile>;
  resolvedProfiles: ResolvedProfileEntry[];
  skillResolvedProfiles: Map<
    SubagentProfile,
    { ok: true; profile: SubagentProfile } | { ok: false; error: string }
  >;
  allToolNames: string[] | undefined;
  agentDir: string;
}

/**
 * Resolve profiles, validate tools/skills, and pre-resolve skill paths
 * for all tasks in a delegation request.
 */
async function resolveTaskProfiles(
  params: StaticDelegateParams,
  cwd: string,
  pi: ExtensionAPI,
): Promise<ProfileResolutionResult> {
  const profiles = loadProfiles(cwd);

  // Pre-resolve profiles for each task (avoids double resolution)
  const resolvedProfiles: ResolvedProfileEntry[] = params.tasks.map((t) => {
    const name = t.profile ?? params.profile;
    const profile = name ? resolveProfile(profiles, name) : undefined;
    return { name, profile };
  });

  const allToolNames = applyToolExcludeLists(resolvedProfiles, pi);

  // Validate skills in profiles
  for (const { name, profile } of resolvedProfiles) {
    if (profile) {
      validateProfileSkills(profile, name);
    }
  }

  const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const skillMap = await discoverSkillsIfNeeded(resolvedProfiles, cwd, agentDir);
  const skillResolvedProfiles = await preResolveProfileSkills(resolvedProfiles, cwd, skillMap);

  return { profiles, resolvedProfiles, skillResolvedProfiles, allToolNames, agentDir };
}

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
  task: SubAgentTask,
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
  task: SubAgentTask,
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

// ── Per-Task Execution ────────────────────────────────────────────────

/** Shared context for running a single sub-agent task */
interface TaskRunContext {
  win: SubAgentWindow;
  session: SubagentSessionData;
  rp: ResolvedProfileEntry;
  profiles: Record<string, SubagentProfile>;
  skillResolvedProfiles: Map<
    SubagentProfile,
    { ok: true; profile: SubagentProfile } | { ok: false; error: string }
  >;
  sessionStore: Map<string, SessionRecord>;
  taskCwd: string;
  maxLines: number;
  loopingToolCount: number;
  agentDir: string;
  extendDebounce: number;
  emitUpdate: () => void;
  persistSession: (session: SubagentSessionData) => void;
  parentSignal: AbortSignal | undefined;
}

/**
 * Mark a window and session as errored with the given message.
 */
function markTaskError(
  win: SubAgentWindow,
  session: SubagentSessionData,
  errorMessage: string,
  emitUpdate: () => void,
): void {
  win.status = "error";
  session.status = "error";
  win.errorMessage = errorMessage;
  session.errorMessage = errorMessage;
  win.exitCode = 1;
  session.exitCode = 1;
  emitUpdate();
}

/**
 * Check if a profile has skills that need resolution.
 */
function profileNeedsSkillResolution(profile: SubagentProfile | undefined): boolean {
  return !!profile && (!!profile.suggestedSkills?.length || !!profile.loadSkills?.length);
}

/**
 * Resolve pre-resolved skills for a profile, returning the enhanced profile
 * or marking the task as errored.
 */
function resolveSkillProfile(
  profile: SubagentProfile,
  skillResolvedProfiles: Map<
    SubagentProfile,
    { ok: true; profile: SubagentProfile } | { ok: false; error: string }
  >,
  win: SubAgentWindow,
  session: SubagentSessionData,
  emitUpdate: () => void,
  persistSession: (session: SubagentSessionData) => void,
): SubagentProfile | undefined {
  const result = skillResolvedProfiles.get(profile);
  if (!result || !result.ok) {
    markTaskError(win, session, result?.error ?? "Skill resolution failed", emitUpdate);
    persistSession(session);
    return undefined;
  }
  return result.profile;
}

/**
 * Validate and resolve the profile for a single task.
 * Returns the resolved profile with skills, or marks the task as errored.
 */
function resolveTaskProfile(ctx: TaskRunContext): SubagentProfile | undefined {
  const { win, session, rp, profiles, emitUpdate, persistSession, skillResolvedProfiles } = ctx;

  if (rp.name && !rp.profile) {
    markTaskError(
      win,
      session,
      `Unknown profile: "${rp.name}". Available profiles: ${Object.keys(profiles).join(", ") || "(none)"}`,
      emitUpdate,
    );
    persistSession(session);
    return undefined;
  }

  if (profileNeedsSkillResolution(rp.profile)) {
    return resolveSkillProfile(
      rp.profile as SubagentProfile,
      skillResolvedProfiles,
      win,
      session,
      emitUpdate,
      persistSession,
    );
  }

  return rp.profile;
}

/**
 * Build the effective prompt for a task, applying resume context and file contents.
 */
async function buildEffectivePrompt(
  task: SubAgentTask,
  sessionStore: Map<string, SessionRecord>,
  taskCwd: string,
): Promise<string> {
  let effectivePrompt = task.prompt;

  // Format prompt for resume if applicable
  if (task.resume) {
    const record = sessionStore.get(task.resume);
    if (record) {
      const previousData = formatRunsForResume(record.runs);
      effectivePrompt = `Previously:\n\n${previousData}\n\nInstructions:\n\n${task.prompt}`;
    }
  }

  // Prepend file contents if specified
  if (task.files && task.files.length > 0) {
    const fileBlocks = await Promise.all(
      task.files.map((spec) => readFileContents(spec, task.cwd ?? taskCwd)),
    );
    effectivePrompt = `${fileBlocks.join("\n\n")}\n\n${effectivePrompt}`;
  }

  return effectivePrompt;
}

/**
 * Set up idle-timer based timeout for a sub-agent task.
 * Returns cleanup function and reset function.
 */
function setupIdleTimeout(
  win: SubAgentWindow,
  taskTimeout: number,
  extendDebounce: number,
  parentSignal: AbortSignal | undefined,
  taskAbortController: AbortController,
): { cleanup: () => void; resetTimer: () => void } {
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

  const resetTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    startIdleTimer();
  };

  const cleanup = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  };

  // Forward parent signal to task controller
  const onParentAbort = () => {
    taskAbortController.abort();
  };
  if (parentSignal?.aborted) {
    taskAbortController.abort();
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  // Start the idle timer immediately
  startIdleTimer();

  return {
    cleanup: () => {
      cleanup();
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onParentAbort);
      }
    },
    resetTimer,
  };
}

/**
 * Handle post-run result: detect loops and timeouts.
 */
function handlePostRunResult(
  loopDetected: boolean,
  taskAbortController: AbortController,
  parentSignal: AbortSignal | undefined,
  win: SubAgentWindow,
  session: SubagentSessionData,
  emitUpdate: () => void,
): void {
  if (loopDetected) {
    markTaskError(win, session, LOOP_DETECTED_MESSAGE, emitUpdate);
    win.completedAt = Date.now();
    taskAbortController.abort();
  }

  // Check if timeout caused the abort (not loop detection, not parent abort)
  if (!loopDetected && taskAbortController.signal.aborted && !parentSignal?.aborted) {
    const elapsedSeconds = Math.round((Date.now() - win.startedAt) / 1000);
    markTaskError(
      win,
      session,
      `Timed out after ${elapsedSeconds}s. Consider resuming with a longer timeout.`,
      emitUpdate,
    );
    win.completedAt = Date.now();
  }
}

/**
 * Run a single sub-agent task within a delegation batch.
 */
async function runSingleTask(task: SubAgentTask, ctx: TaskRunContext): Promise<void> {
  const { win, session, emitUpdate, persistSession } = ctx;
  const skillResolvedProfile = resolveTaskProfile(ctx);
  // resolveTaskProfile returns undefined both when no profile is needed
  // (normal) and when an error occurred (unknown profile, skill failure).
  // Only bail when the window was marked as errored.
  if (win.status === "error") return;

  const effectivePrompt = await buildEffectivePrompt(task, ctx.sessionStore, ctx.taskCwd);
  const effectiveTask = { ...task, prompt: effectivePrompt };

  // Create per-task timeout
  const taskTimeout = Math.max(1, task.timeout ?? DEFAULT_TIMEOUT);
  const taskAbortController = new AbortController();
  const { cleanup, resetTimer } = setupIdleTimeout(
    win,
    taskTimeout,
    ctx.extendDebounce,
    ctx.parentSignal,
    taskAbortController,
  );

  const wrappedEmitUpdate = () => {
    emitUpdate();
    resetTimer();
  };

  // eslint-disable-next-line no-useless-assignment
  let loopDetected = false;

  try {
    const result = await runSubAgent({
      task: effectiveTask,
      win,
      maxLines: ctx.maxLines,
      signal: taskAbortController.signal,
      onUpdate: wrappedEmitUpdate,
      session,
      profile: skillResolvedProfile,
      loopingToolCount: ctx.loopingToolCount,
      agentDir: ctx.agentDir,
    });
    loopDetected = result.loopDetected;
  } finally {
    cleanup();
  }

  handlePostRunResult(
    loopDetected,
    taskAbortController,
    ctx.parentSignal,
    win,
    session,
    emitUpdate,
  );

  // Persist session data after completion/error
  persistSession(session);
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
