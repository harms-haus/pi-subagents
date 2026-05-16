/**
 * Sub-Agent Spawner
 *
 * Handles spawning child processes for sub-agents, managing their stdout/stderr,
 * and processing JSON events from the pi binary.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { formatToolCall } from "./format-tool-call";
import { profileToArgs } from "./profiles";
import { loadCommandPreviewWidth } from "./settings";
import { MAX_MESSAGES_PER_SESSION, syncState } from "./types";
import {
  appendLineToWindow,
  getTextParts,
} from "./utils";
import type { SubagentProfile } from "./profiles";
import type { SubAgentTask, SubAgentWindow, SubagentSessionData, ToolCallPart } from "./types";
import type { Message } from "@earendil-works/pi-ai";

// ── Types ────────────────────────────────────────────────────────────

export interface RunSubAgentOptions {
  task: SubAgentTask;
  win: SubAgentWindow;
  maxLines: number;
  signal?: AbortSignal;
  onUpdate: () => void;
  session: SubagentSessionData;
  profile?: SubagentProfile;
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
  if (!target.startsWith("/")) {
    throw new Error("cwd must be an absolute path");
  }
  if (target.includes("..")) {
    throw new Error("cwd must not contain '..' path segments");
  }
  return target;
}

// ── Main Function ────────────────────────────────────────────────────

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
): void {
  if (!line.trim()) {return;}

  let event: { type?: string; message?: Message };
  try {
    event = JSON.parse(line) as { type?: string; message?: Message };
  } catch {
    appendLineToWindow(win, line, maxLines);
    onUpdate();
    return;
  }

  if (event.type !== "message_end" || !event.message) {return;}

  const msg = event.message;
  session.messages.push(msg);
  if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
    session.messages.shift();
  }

  const textParts = getTextParts(msg);
  const hasTextOrContent = textParts.length > 0 || (msg.role === "assistant" && msg.content);

  if (hasTextOrContent) {
    for (const text of textParts) {
      const textLines = text.split("\n");
      for (const textLine of textLines) {
        appendLineToWindow(win, textLine, maxLines);
      }
    }

    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "toolCall") {
          const toolArgs = (part as ToolCallPart).arguments || {};
          const toolName = (part as ToolCallPart).name;
          const preview = formatToolCall(toolName, toolArgs, cwd, widthBudget);
          appendLineToWindow(win, `→ ${preview}`, maxLines, "tool");

          // Track todo progress
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
            if (editAction === "complete" && editIndices) {
              win.todoCompleted = (win.todoCompleted ?? 0) + editIndices.length;
            } else if (editAction === "add" && toolArgs.todos) {
              win.todoTotal = (win.todoTotal ?? 0) + ((toolArgs.todos as unknown[] | undefined)?.length ?? 0);
            } else if (editAction === "abandon" && editIndices) {
              win.todoCompleted = (win.todoCompleted ?? 0) + editIndices.length;
            }
          }
        }
      }
    }
  }

  if (msg.role === "assistant" && (msg.model || msg.stopReason || msg.errorMessage)) {
    win.model = msg.model;
    win.stopReason = msg.stopReason;
    win.errorMessage = msg.errorMessage;
    syncState(win, session);
  }

  onUpdate();
}

/**
 * Process stderr data from the sub-agent process.
 */
function handleStderrData(data: Buffer, win: SubAgentWindow, maxLines: number, onUpdate: () => void): void {
  const text = data.toString().trim();
  if (!text) {return;}

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
  if (buffer.trim()) {processLineFn(buffer);}
  if (bufferTimeout) {clearTimeout(bufferTimeout);}

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
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) {proc.kill("SIGKILL");}
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
export async function runSubAgent(options: RunSubAgentOptions): Promise<void> {
  const { task, win, maxLines, signal, onUpdate, session, profile } = options;

  // Compute command preview width (once per sub-agent run)
  const lineBudget = await loadCommandPreviewWidth(task.cwd);

  const invocation = getPiInvocation();
  const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];

  // Inject profile-specific CLI arguments before the prompt
  let profileEnv: Record<string, string> = {};
  if (profile) {
    const { args: profileArgs, env: envVars } = profileToArgs(profile);
    args.push(...profileArgs);
    profileEnv = envVars;
  }

  args.push('-');

  let buffer = "";
  let bufferTimeout: ReturnType<typeof setTimeout> | null = null;

  // Debounced onUpdate to reduce TUI pressure
  const debouncedUpdate = () => {
    if (bufferTimeout) {clearTimeout(bufferTimeout);}
    bufferTimeout = setTimeout(() => onUpdate(), 50);
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

    const processLine = (line: string) => {
      handleStdoutLine(line, win, maxLines, session, debouncedUpdate, resolvedCwd, lineBudget);
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
      if (bufferTimeout) {clearTimeout(bufferTimeout);}
      win.exitCode = 1;
      win.status = "error";
      win.errorMessage = win.errorMessage || "Failed to spawn sub-agent process";
      syncState(win, session);
      onUpdate();
      resolve();
    };

    proc.on("close", (code) => {
      handleProcessExit(code, win, session, buffer, bufferTimeout, processLine, onUpdate);
      resolve();
    });

    // Write prompt via stdin to avoid OS ARG_MAX limits
    proc.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") {
        handleStderrData(Buffer.from(`[stdin error]: ${err.message}`), win, maxLines, debouncedUpdate);
      }
    });
    proc.stdin.end(task.prompt);

    proc.on("error", handleError);

    if (signal) {
      setupAbortHandler(proc, signal);
    }
  });
}
