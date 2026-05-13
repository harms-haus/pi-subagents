/**
 * Sub-Agent Spawner
 *
 * Handles spawning child processes for sub-agents, managing their stdout/stderr,
 * and processing JSON events from the pi binary.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { SubagentProfile } from "./profiles";
import { profileToArgs } from "./profiles";
import type { SubAgentTask, SubAgentWindow, SubagentSessionData, ToolCallPart } from "./types";
import { MAX_MESSAGES_PER_SESSION, syncState } from "./types";
import { appendLineToWindow, getPiInvocation, getTextParts } from "./utils";

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
function formatToolCall(toolName: string, args: Record<string, any>): string {
  switch (toolName) {
    // File mutations: just show the filename
    case "edit":
    case "write": {
      const path = args.path ?? args.filePath ?? "...";
      const count = args.edits?.length;
      const suffix = count ? ` (${count} edit${count > 1 ? "s" : ""})` : "";
      return `${toolName} → ${path}${suffix}`;
    }

    case "bash": {
      const cmd = (args.command ?? "...").split("\n")[0];
      const truncated = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
      return `bash → ${truncated}`;
    }

    case "read": {
      const path = args.path ?? "...";
      const parts = [path];
      if (args.offset) parts.push(`:${args.offset}`);
      if (args.limit) parts.push(`+${args.limit}`);
      return `read → ${parts.join("")}`;
    }

    // Delegation
    case "delegate_to_subagents": {
      const tasks = args.tasks ?? [];
      const profiles = tasks.map((t: any) => t.profile).filter(Boolean);
      const profileStr = profiles.length > 0 ? ` [${profiles.join(", ")}]` : args.profile ? ` [${args.profile}]` : "";
      return `delegate_to_subagents → ${tasks.length} task${tasks.length !== 1 ? "s" : ""}${profileStr}`;
    }

    // Todo tools
    case "write_todos": {
      const n = args.todos?.length ?? 0;
      return `write_todos → ${n} todo${n !== 1 ? "s" : ""}`;
    }
    case "edit_todos": {
      const indices = args.indices?.join(",") ?? "...";
      return `edit_todos → ${args.action ?? "?"} [${indices}]`;
    }
    case "list_todos":
      return "list_todos";

    // LSP tools
    case "lsp-diagnostics":
    case "lsp_diagnostics": {
      const file = args.file ?? "...";
      return `lsp-diagnostics → ${file}`;
    }
    case "lsp-find-references":
    case "lsp_find_references": {
      const file = args.file ?? "...";
      return `lsp-find-refs → ${file}:${args.line}:${args.column}`;
    }
    case "lsp-goto-definition":
    case "lsp_goto_definition": {
      const file = args.file ?? "...";
      return `lsp-goto-def → ${file}:${args.line}:${args.column}`;
    }
    case "lsp-find-symbol":
    case "lsp_find_symbol":
      return `lsp-find-symbol → ${args.query ?? "..."}`;
    case "lsp-call-hierarchy":
    case "lsp_call_hierarchy": {
      const file = args.file ?? "...";
      return `lsp-call-hierarchy → ${file}:${args.line}:${args.column}`;
    }
    case "lsp-refactor-symbol":
    case "lsp_refactor_symbol": {
      const file = args.file ?? "...";
      return `lsp-rename → ${file}:${args.line}:${args.column} → ${args.newName ?? "..."}`;
    }

    // Lint
    case "lint-files":
    case "lint_files": {
      const files = args.files;
      if (files && files.length > 0) {
        const preview =
          files.length <= 3 ? files.join(", ") : `${files.slice(0, 2).join(", ")}, ... +${files.length - 2} more`;
        return `lint → ${preview}`;
      }
      return "lint → (all)";
    }

    // Fetch tools
    case "fetch-content":
    case "fetch_content":
    case "web_search": {
      const url = args.url ?? args.query ?? "...";
      const truncated = url.length > 80 ? `${url.slice(0, 77)}...` : url;
      return `${toolName} → ${truncated}`;
    }
    case "fetch-repo":
    case "fetch_repo": {
      const url = args.url ?? "...";
      return `fetch-repo → ${url}`;
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
      // Generic fallback: show name + first arg value if short
      const keys = Object.keys(args);
      if (keys.length === 0) return toolName;
      const firstVal = String(args[keys[0]] ?? "");
      if (firstVal.length > 60) return `${toolName} → ...`;
      return `${toolName} → ${firstVal}`;
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
): void {
  if (!line.trim()) return;

  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    appendLineToWindow(win, line, maxLines);
    onUpdate();
    return;
  }

  if (event.type !== "message_end" || !event.message) return;

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

    if (msg.content) {
      for (const part of msg.content) {
        if (part.type === "toolCall") {
          const toolArgs = (part as ToolCallPart).arguments || {};
          const preview = formatToolCall((part as ToolCallPart).name, toolArgs);
          appendLineToWindow(win, `→ ${preview}`, maxLines, "tool");
        }
      }
    }
  }

  if (msg.model || msg.stopReason || msg.errorMessage) {
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
  if (!text) return;

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
  if (buffer.trim()) processLineFn(buffer);
  if (bufferTimeout) clearTimeout(bufferTimeout);

  const exitCode = code ?? 0;
  win.exitCode = exitCode;

  const isError = code !== 0 || win.stopReason === "error" || win.stopReason === "aborted";
  const status = isError ? "error" : "completed";

  win.status = status;
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
      if (!proc.killed) proc.kill("SIGKILL");
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
    if (bufferTimeout) clearTimeout(bufferTimeout);
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
      handleStdoutLine(line, win, maxLines, session, debouncedUpdate);
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
      if (bufferTimeout) clearTimeout(bufferTimeout);
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
