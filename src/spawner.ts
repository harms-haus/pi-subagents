/**
 * Sub-Agent Spawner
 *
 * Handles spawning child processes for sub-agents, managing their stdout/stderr,
 * and processing JSON events from the pi binary.
 */

import { spawn } from "node:child_process";
import kill from "tree-kill";
import { isAbsolute, resolve } from "node:path";
import { formatToolCall, formatToolResultInline, getToolEmoji } from "./format-tool-call";
import { profileToArgs } from "./profiles";
import { loadCommandPreviewWidth } from "./settings";
import { MAX_MESSAGES_PER_SESSION, syncState } from "./types";
import { appendLineToWindow, getTextParts } from "./utils";
import type { SubagentProfile } from "./profiles";
import type { SubAgentTask, SubAgentWindow, SubagentSessionData, ToolCallPart } from "./types";
import type { Message } from "@earendil-works/pi-ai";

// ── Helpers ───────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────

export interface RunSubAgentOptions {
  task: SubAgentTask;
  win: SubAgentWindow;
  maxLines: number;
  signal?: AbortSignal;
  onUpdate: () => void;
  session: SubagentSessionData;
  profile?: SubagentProfile;
  loopingToolCount?: number;
  agentDir?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Determine how to invoke the pi binary.
 * Returns the command and arguments needed to spawn a sub-agent process.
 */
function getPiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}

/**
 * Validate and resolve the cwd parameter for a sub-agent task.
 */
function validateCwd(cwd: string | undefined, fallback: string): string {
  const target = cwd ? resolve(cwd) : fallback;
  if (!isAbsolute(target)) {
    throw new Error("cwd must be an absolute path");
  }
  // resolve() already normalizes .. segments; this check is defense-in-depth
  if (target.includes("..")) {
    throw new Error("cwd must not contain '..' path segments");
  }
  return target;
}

// ── Main Function ────────────────────────────────────────────────────

// ── Stdout line processing helpers ─────────────────────────────────────

/** Context object passed to all stdout processing helpers. */
interface LineContext {
  win: SubAgentWindow;
  maxLines: number;
  session: SubagentSessionData;
  onUpdate: () => void;
  cwd: string;
  widthBudget: number;
  loopingToolCount: number;
}

/**
 * Process a turn_end event to inline ls/find result summaries.
 */
function handleTurnEnd(event: { type?: string }, ctx: LineContext): void {
  const turnEvent = event as {
    toolResults?: Array<{
      toolName: string;
      content: Array<{ type: string; text?: string }>;
      details?: Record<string, unknown>;
      isError: boolean;
    }>;
  };
  const toolResults = turnEvent.toolResults;
  if (!Array.isArray(toolResults)) {
    return;
  }

  const usedIndices = new Set<number>();
  for (const result of toolResults) {
    if (result.isError || (result.toolName !== "ls" && result.toolName !== "find")) {
      continue;
    }
    inlineToolResultSummary(result, ctx, usedIndices);
  }
  ctx.onUpdate();
}

/**
 * Inline a single ls/find tool result summary into the window.
 */
function inlineToolResultSummary(
  result: {
    toolName: string;
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  },
  ctx: LineContext,
  usedIndices: Set<number>,
): void {
  const textParts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    }
  }
  const textContent = textParts.join("");
  if (!textContent) {
    return;
  }

  const inlineSummary = formatToolResultInline(result.toolName, textContent, result.details);
  if (!inlineSummary) {
    return;
  }

  const marker = `${result.toolName} →`;
  // Find the first unused tool line matching this tool name
  // that has NOT already received an inline result from a previous turn.
  // A bare tool call line ("📂 ls → src") has no " → " after the path,
  // while an already-inlined line ("📂 ls → src → 2 files") does.
  for (let i = 0; i < ctx.win.lines.length; i++) {
    const line = ctx.win.lines[i];
    if (!line) continue;
    if (
      !usedIndices.has(i) &&
      line.kind === "tool" &&
      line.text.includes(marker) &&
      !line.text.slice(line.text.indexOf(marker) + marker.length).includes(" → ")
    ) {
      usedIndices.add(i);
      // Mutate the text directly — same object ref is in allMessages
      line.text = `${line.text} → ${inlineSummary}`;
      return;
    }
  }
  appendLineToWindow(ctx.win, `  ${result.toolName}: ${inlineSummary}`, ctx.maxLines, "tool");
}

/**
 * Track todo progress from write_todos / edit_todos tool calls.
 */
function trackTodoProgress(
  toolName: string,
  toolArgs: Record<string, unknown>,
  win: SubAgentWindow,
): void {
  if (toolName === "write_todos") {
    const newCount = (toolArgs.todos as unknown[] | undefined)?.length ?? 0;
    const mode = toolArgs.mode as string | undefined;
    if (mode === "append") {
      win.todoTotal = (win.todoTotal ?? 0) + newCount;
    } else {
      win.todoTotal = newCount;
      win.todoCompleted = 0;
    }
  } else if (toolName === "edit_todos") {
    const editAction = toolArgs.action as string | undefined;
    const editIndices = toolArgs.indices as number[] | undefined;
    if ((editAction === "complete" || editAction === "abandon") && editIndices) {
      win.todoCompleted = (win.todoCompleted ?? 0) + editIndices.length;
    }
  }
}

/**
 * Track a tool call signature for loop detection, capping the buffer.
 */
function trackToolCallForLoop(
  toolName: string,
  toolArgs: Record<string, unknown>,
  win: SubAgentWindow,
  loopingToolCount: number,
): void {
  const signature = `${toolName}:${JSON.stringify(toolArgs, Object.keys(toolArgs).sort())}`;

  if (!win.recentToolCalls) {
    win.recentToolCalls = [];
  }
  win.recentToolCalls.push(signature);
  // Cap to only what's needed for loop detection
  const maxKept = Math.max(loopingToolCount * 2, 20);
  if (win.recentToolCalls.length > maxKept) {
    win.recentToolCalls = win.recentToolCalls.slice(-maxKept);
  }
}

/**
 * Process a single tool call from a message: format, track todos, and record for loop detection.
 */
function processToolCall(part: ToolCallPart, ctx: LineContext): void {
  const toolArgs = part.arguments || {};
  const toolName = part.name;
  const preview = formatToolCall(toolName, toolArgs, ctx.cwd, ctx.widthBudget);
  const emoji = getToolEmoji(toolName);
  appendLineToWindow(ctx.win, `${emoji} ${preview}`, ctx.maxLines, "tool");

  trackTodoProgress(toolName, toolArgs, ctx.win);
  trackToolCallForLoop(toolName, toolArgs, ctx.win, ctx.loopingToolCount);
}

/**
 * Render text parts from a message into the window.
 */
function processTextParts(textParts: string[], ctx: LineContext): void {
  for (const text of textParts) {
    for (const textLine of text.split("\n")) {
      appendLineToWindow(ctx.win, textLine, ctx.maxLines);
    }
  }
}

/**
 * Sync assistant metadata (model, stopReason, errorMessage) from message to window/session.
 */
function syncAssistantMeta(msg: Message, win: SubAgentWindow, session: SubagentSessionData): void {
  if (msg.role !== "assistant") {
    return;
  }
  win.model = msg.model;
  win.stopReason = msg.stopReason;
  win.errorMessage = msg.errorMessage;
  syncState(win, session);
}

/**
 * Check whether the last N tool calls are all identical (loop detection).
 */
function checkLoop(win: SubAgentWindow, loopingToolCount: number): boolean {
  if (
    loopingToolCount <= 0 ||
    !win.recentToolCalls ||
    win.recentToolCalls.length < loopingToolCount
  ) {
    return false;
  }
  const recent = win.recentToolCalls.slice(-loopingToolCount);
  for (let i = 1; i < recent.length; i++) {
    if (recent[0] !== recent[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Process a message_end event: store the message, render content, and detect loops.
 */
function handleMessageEnd(msg: Message, ctx: LineContext): { loopDetected: boolean } {
  ctx.session.messages.push(msg);
  if (ctx.session.messages.length >= MAX_MESSAGES_PER_SESSION) {
    ctx.session.messages.shift();
  }

  const textParts = getTextParts(msg);
  const hasContent = textParts.length > 0 || (msg.role === "assistant" && msg.content);

  if (hasContent) {
    processTextParts(textParts, ctx);

    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "toolCall") {
          processToolCall(part, ctx);
        }
      }
    }
  }

  syncAssistantMeta(msg, ctx.win, ctx.session);
  ctx.onUpdate();

  return { loopDetected: checkLoop(ctx.win, ctx.loopingToolCount) };
}

/**
 * Process a single line of stdout output from the sub-agent process.
 * Handles both plain text lines and JSON events.
 */
function handleStdoutLine(
  line: string,
  win: SubAgentWindow,
  maxLines: number,
  session: SubagentSessionData,
  onUpdate: () => void,
  cwd: string,
  widthBudget: number,
  loopingToolCount: number,
): { loopDetected: boolean } {
  if (!line.trim()) {
    return { loopDetected: false };
  }

  let event: { type?: string; message?: Message };
  try {
    event = JSON.parse(line) as { type?: string; message?: Message };
  } catch {
    appendLineToWindow(win, line, maxLines);
    onUpdate();
    return { loopDetected: false };
  }

  const ctx: LineContext = { win, maxLines, session, onUpdate, cwd, widthBudget, loopingToolCount };

  if (event.type === "turn_end") {
    handleTurnEnd(event, ctx);
    return { loopDetected: false };
  }

  if (event.type === "message_end" && event.message) {
    return handleMessageEnd(event.message, ctx);
  }

  return { loopDetected: false };
}

/**
 * Process stderr data from the sub-agent process.
 */
function handleStderrData(
  data: Buffer,
  win: SubAgentWindow,
  maxLines: number,
  onUpdate: () => void,
): void {
  const text = data.toString().trim();
  if (!text) {
    return;
  }

  appendLineToWindow(win, `[stderr]: ${text}`, maxLines);
  onUpdate();
}

/**
 * Handle the sub-agent process exit.
 */
function handleProcessExit(
  code: number | null,
  win: SubAgentWindow,
  session: SubagentSessionData,
  buffer: string,
  bufferTimeout: ReturnType<typeof setTimeout> | null,
  processLineFn: (line: string) => void,
  onUpdate: () => void,
): void {
  if (buffer.trim()) {
    processLineFn(buffer);
  }
  if (bufferTimeout) {
    clearTimeout(bufferTimeout);
  }

  const exitCode = code ?? 0;
  win.exitCode = exitCode;

  const isError = code !== 0 || win.stopReason === "error" || win.stopReason === "aborted";
  const status = isError ? "error" : "completed";

  win.status = status;
  win.completedAt = Date.now();
  syncState(win, session);

  onUpdate();
}

/**
 * Set up abort signal handler with SIGTERM/SIGKILL escalation.
 */
function setupAbortHandler(proc: ReturnType<typeof spawn>, signal: AbortSignal): void {
  const killProc = () => {
    if (proc.pid) {
      kill(proc.pid, "SIGTERM");
    }
    setTimeout(() => {
      if (proc.pid) {
        kill(proc.pid, "SIGKILL");
      }
    }, 5000);
  };

  if (signal.aborted) {
    killProc();
    return;
  }

  signal.addEventListener("abort", killProc, { once: true });
}

/**
 * Spawn a sub-agent process and manage its lifecycle.
 *
 * Handles spawning the pi binary, buffering stdout/stderr, parsing JSON events,
 * updating the rolling window, and managing abort signals with SIGTERM/SIGKILL escalation.
 */
export async function runSubAgent(options: RunSubAgentOptions): Promise<{ loopDetected: boolean }> {
  const { task, win, maxLines, signal, onUpdate, session, profile } = options;

  // Compute command preview width (once per sub-agent run)
  const lineBudget = await loadCommandPreviewWidth(task.cwd);

  const effectiveLoopingToolCount = options.loopingToolCount ?? 5;

  const invocation = getPiInvocation();
  const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];

  // Inject profile-specific CLI arguments before the prompt
  let profileEnv: Record<string, string> = {};
  if (profile) {
    const { args: profileArgs, env: envVars } = profileToArgs(profile, task.cwd, options.agentDir);
    args.push(...profileArgs);
    profileEnv = envVars;
  }

  let buffer = "";
  let bufferTimeout: ReturnType<typeof setTimeout> | null = null;

  // Debounced onUpdate to reduce TUI pressure
  const debouncedUpdate = () => {
    if (bufferTimeout) {
      clearTimeout(bufferTimeout);
    }
    bufferTimeout = setTimeout(() => {
      onUpdate();
    }, 50);
  };

  // Validate and resolve the cwd parameter
  const resolvedCwd = validateCwd(task.cwd, process.cwd());

  return new Promise((resolve) => {
    const proc = spawn(invocation.command, args, {
      cwd: resolvedCwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...profileEnv },
    });

    let loopDetectedFlag = false;

    const processLine = (line: string) => {
      if (loopDetectedFlag) {
        return;
      } // short-circuit after detection
      const result = handleStdoutLine(
        line,
        win,
        maxLines,
        session,
        debouncedUpdate,
        resolvedCwd,
        lineBudget,
        effectiveLoopingToolCount,
      );
      if (result.loopDetected) {
        loopDetectedFlag = true;
        if (proc.pid) {
          kill(proc.pid, "SIGTERM"); // kill the looping process immediately
        }
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
      handleStderrData(data, win, maxLines, debouncedUpdate);
    });

    const handleError = () => {
      if (bufferTimeout) {
        clearTimeout(bufferTimeout);
      }
      win.exitCode = 1;
      win.status = "error";
      win.errorMessage = win.errorMessage || "Failed to spawn sub-agent process";
      syncState(win, session);
      onUpdate();
      resolve({ loopDetected: false });
    };

    proc.on("close", (code) => {
      handleProcessExit(code, win, session, buffer, bufferTimeout, processLine, onUpdate);
      resolve({ loopDetected: loopDetectedFlag });
    });

    // Write prompt via stdin to avoid OS ARG_MAX limits
    proc.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") {
        handleStderrData(
          Buffer.from(`[stdin error]: ${err.message}`),
          win,
          maxLines,
          debouncedUpdate,
        );
      }
    });
    proc.stdin.end(task.prompt);

    proc.on("error", handleError);

    if (signal) {
      setupAbortHandler(proc, signal);
    }
  });
}
