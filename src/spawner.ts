/**
 * Sub-Agent Spawner
 *
 * Handles spawning child processes for sub-agents, managing their stdout/stderr,
 * and processing JSON events from the pi binary.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadCommandPreviewWidth, profileToArgs } from "./profiles";
import { MAX_MESSAGES_PER_SESSION, syncState } from "./types";
import {
  appendLineToWindow,
  collapseCdDot,
  formatBashCommand,
  getPiInvocation,
  getTextParts,
  shortenPath,
  shortenPathsInText,
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

/**
 * Format a tool call as a concise one-liner for the sub-agent rolling window.
 * Avoids dumping full JSON arguments for common tools.
 */
function formatToolCall(toolName: string, args: Record<string, unknown>, cwd: string, widthBudget: number): string {
  // Typed view of args for display formatting
  const a = args as Record<string, string>;
  switch (toolName) {
    // File mutations: just show the filename
    case "edit":
    case "write": {
      const path = shortenPath(a.path ?? a.filePath ?? "...", cwd);
      const count = (args.edits as unknown[] | undefined)?.length;
      const suffix = count ? ` (${count} edit${count > 1 ? "s" : ""})` : "";
      return `${toolName} → ${path}${suffix}`;
    }

    case "bash": {
      let cmd = (a.command ?? "...").split("\n")[0];
      cmd = collapseCdDot(cmd, cwd);
      if (cmd === "." || cmd === "") {
        return `bash → cd .`;
      }
      cmd = shortenPathsInText(cmd, cwd);
      return `bash → ${formatBashCommand(cmd, widthBudget - 12, widthBudget - 5)}`;
    }

    case "read": {
      const path = shortenPath(a.path ?? "...", cwd);
      const parts = [path];
      if (a.offset) {parts.push(`:${a.offset}`);}
      if (a.limit) {parts.push(`+${a.limit}`);}
      return `read → ${parts.join("")}`;
    }

    // Delegation
    case "delegate_to_subagents": {
      const tasks = (args.tasks ?? []) as { profile?: string }[];
      const profiles = tasks.map((t) => t.profile).filter(Boolean);
      const profileStr = profiles.length > 0 ? ` [${profiles.join(", ")}]` : a.profile ? ` [${a.profile}]` : "";
      return `delegate_to_subagents → ${tasks.length} task${tasks.length !== 1 ? "s" : ""}${profileStr}`;
    }

    // Todo tools
    case "write_todos": {
      const n = (args.todos as unknown[] | undefined)?.length ?? 0;
      return `write_todos → ${n} todos written`;
    }
    case "edit_todos": {
      const action = String(args.action ?? "?");
      const indices = (args.indices as number[] | undefined) ?? [];
      const todos = args.todos as Array<{text?: string}> | undefined;
      let desc: string;
      if (todos && todos.length > 0) {
        desc = todos.map(t => t.text ?? "").join(", ");
        if (desc.length > 48) {desc = `${desc.slice(0, 45)}...`;}
      } else {
        desc = `${action} [${indices.join(",")}]`;
      }
      return `edit_todos → ${desc}`;
    }
    case "list_todos":
      return "list_todos";

    // LSP tools
    case "lsp_diagnostics": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_diagnostics → ${file}`;
    }
    case "lsp_find_references": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_find_references → ${file}:${a.line}:${a.column}`;
    }
    case "lsp_goto_definition": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_goto_definition → ${file}:${a.line}:${a.column}`;
    }
    case "lsp_find_symbol":
      return `lsp_find_symbol → ${a.query ?? "..."}`;
    case "lsp_call_hierarchy": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_call_hierarchy → ${file}:${a.line}:${a.column}`;
    }
    case "lsp_refactor_symbol": {
      const file = shortenPath(a.file ?? "...", cwd);
      return `lsp_refactor_symbol → ${file}:${a.line}:${a.column} → ${a.newName ?? "..."}`;
    }

    // Lint
    case "lint_files": {
      const files = args.files as string[] | undefined;
      if (files && files.length > 0) {
        const shortened = files.map((f) => shortenPath(f, cwd));
        const preview =
          shortened.length <= 3
            ? shortened.join(", ")
            : `${shortened.slice(0, 2).join(", ")}, ... +${shortened.length - 2} more`;
        return `lint → ${preview}`;
      }
      return "lint → (all)";
    }

    // Fetch tools
    case "fetch_content":
    case "web_search": {
      const url = a.url ?? a.query ?? "...";
      const urlBudget = widthBudget - toolName.length - 4;
      const truncated = url.length > urlBudget ? `${url.slice(0, urlBudget - 3)}...` : url;
      return `${toolName} → ${truncated}`;
    }
    case "fetch_repo": {
      const url = a.url ?? "...";
      return `fetch_repo → ${url}`;
    }

    // Session retrieval
    case "get_subagent_output":
      return `get_subagent_output → ${args.sessionId ?? "..."}`;
    case "get_subagent_session":
      return `get_subagent_session → ${args.sessionId ?? "..."}`;
    case "list_subagent_profiles":
      return "list_subagent_profiles";

    // Workflow
    case "workflow_step": {
      const action = args.action ?? "?";
      return `workflow_step → ${action}`;
    }

    default: {
      const argsStr = JSON.stringify(args);
      const budget = widthBudget - toolName.length - 1;
      if (argsStr === '{}') {return toolName;}
      if (argsStr.length > budget) {
        return `${toolName} ${argsStr.slice(0, Math.max(0, budget - 3))}...`;
      }
      return `${toolName} ${argsStr}`;
    }
  }
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

  args.push(task.prompt);

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
      stdio: ["ignore", "pipe", "pipe"],
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

    proc.on("error", handleError);

    if (signal) {
      setupAbortHandler(proc, signal);
    }
  });
}
