/**
 * Task execution logic for the delegate tool.
 *
 * Handles running a single sub-agent task: profile resolution, prompt building,
 * idle timeout management, loop/timeout detection, and error marking.
 */

import { runSubAgent } from "../spawner";
import { DEFAULT_TIMEOUT, LOOP_DETECTED_MESSAGE } from "../types";
import type { SubAgentTask } from "../types";
import { readFileContents } from "./delegate-file-reader";
import type { TaskRunContext } from "./delegate-types";
import type { SubagentProfile } from "../profile-types";
import type { SessionRecord, SubAgentWindow, SubagentSessionData } from "../types";

// ── Error Marking ─────────────────────────────────────────────────────

/**
 * Mark a window and session as errored with the given message.
 */
export function markTaskError(
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

// ── Profile Resolution (per-task) ─────────────────────────────────────

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

// ── Prompt Building ───────────────────────────────────────────────────

/**
 * Build the effective prompt for a task, applying resume context and file contents.
 */
export async function buildEffectivePrompt(
  task: SubAgentTask,
  sessionStore: Map<string, SessionRecord>,
  taskCwd: string,
): Promise<string> {
  let effectivePrompt = task.prompt;

  // Format prompt for resume if applicable
  if (task.resume) {
    const record = sessionStore.get(task.resume);
    if (record) {
      const { formatRunsForResume } = await import("../types");
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

// ── Idle Timeout ──────────────────────────────────────────────────────

/**
 * Set up idle-timer based timeout for a sub-agent task.
 * Returns cleanup function and reset function.
 */
export function setupIdleTimeout(
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

// ── Post-Run Handling ─────────────────────────────────────────────────

/**
 * Handle post-run result: detect loops and timeouts.
 */
export function handlePostRunResult(
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

// ── Main Task Runner ──────────────────────────────────────────────────

/**
 * Run a single sub-agent task within a delegation batch.
 */
export async function runSingleTask(task: SubAgentTask, ctx: TaskRunContext): Promise<void> {
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
