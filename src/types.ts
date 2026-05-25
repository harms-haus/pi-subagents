/**
 * pi-subagents Extension Types
 *
 * Core type definitions and configuration constants for the subagent system.
 */

import type { Message } from "@earendil-works/pi-ai";

// ── Configuration ────────────────────────────────────────────────────

/** Maximum number of parallel sub-agent tasks that can be spawned */
export const MAX_PARALLEL_TASKS = 16;

/** Maximum number of concurrent sub-agent processes */
export const MAX_CONCURRENCY = 4;

/** Maximum number of messages to store per session (prevents unbounded memory growth) */
export const MAX_MESSAGES_PER_SESSION = 500;

/** Default timeout for sub-agent tasks (in seconds) */
export const DEFAULT_TIMEOUT = 600;

/** Error message for loop detection kills */
export const LOOP_DETECTED_MESSAGE = "Loop detected: sub-agent is repeating the same tool calls";

/** Custom entry type identifier for persisting subagent session data */
export const CUSTOM_ENTRY_TYPE = "pi-subagents";

// ── Types ────────────────────────────────────────────────────────────

/** Tool call part in a message (used internally for type narrowing) */
export interface ToolCallPart {
  type: "toolCall";
  name: string;
  arguments?: Record<string, unknown>;
}

/** A content part from a Message — text, thinking, or tool call */
export interface TextPart {
  type: "text";
  text: string;
}

export type ContentPart = TextPart | ToolCallPart | { type: string; [key: string]: unknown };

/** Tool result message (used internally for message processing) */
export interface ToolResultMessage {
  role: "toolResult";
  content: Array<{
    type: string;
    text?: string;
  }>;
}

/** A file to inject into the sub-agent prompt, specified as a path string or an object with range options */
export type FileSpec =
  | string
  | { path: string; start?: number; end?: number }
  | { path: string; tail: number }
  | { path: string; head: number };

/** Task definition for spawning a sub-agent */
export interface SubAgentTask {
  name: string;
  prompt: string;
  cwd?: string;
  /** Named profile from an agent-profiles/*.md file */
  profile?: string;
  /** Timeout in seconds (default: 600) */
  timeout?: number;
  /** Previous session ID to resume from */
  resume?: string;
  /** Files to read and prepend to the prompt */
  files?: FileSpec[];
}

/** A single line in a sub-agent's rolling window */
export interface WindowLine {
  text: string;
  kind: "text" | "tool";
}

/** Shared state fields between SubAgentWindow and SubagentSessionData */
export interface SubagentState {
  sessionId: string;
  status: "running" | "completed" | "error";
  exitCode: number | null;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  profileName?: string;
}

/** Live window tracking a sub-agent's progress */
export interface SubAgentWindow extends SubagentState {
  name: string;
  lines: WindowLine[];
  allMessages: WindowLine[];
  /** Human-readable profile summary for display */
  profileInfo?: string;
  /** Provider from the agent profile (e.g. "anthropic", "openai") */
  provider?: string;
  /** Thinking level from the agent profile */
  thinkingLevel?: string;
  /** Date.now() timestamp when the sub-agent started */
  startedAt: number;
  /** Date.now() timestamp when the sub-agent completed (if applicable) */
  completedAt?: number;
  /** Task timeout in seconds */
  timeout: number;
  /** Total number of todo items written */
  todoTotal?: number;
  /** Number of completed todo items */
  todoCompleted?: number;
  /** Number of unique tools available to this sub-agent */
  toolCount: number;
  /** Number of files passed to this sub-agent */
  fileCount: number;
  /** Recent tool call signatures for loop detection (serialized name+args) */
  recentToolCalls?: string[];
}

/** Persistent session data stored for retrieval */
export interface SubagentSessionData extends SubagentState {
  taskName: string;
  prompt: string;
  cwd?: string;
  messages: Message[];
  startedAt: number;
}

/** A record of all runs for a session ID (supports resume/multi-run) */
export interface SessionRecord {
  /** All runs for this session, in chronological order */
  runs: SubagentSessionData[];
}

// ── Helper Functions ───────────────────────────────────────────────────

/**
 * Sync shared state fields from a source SubagentState to a target SubagentState.
 * This ensures that SubAgentWindow and SubagentSessionData stay in sync.
 */
export function syncState(source: SubagentState, target: SubagentState): void {
  target.status = source.status;
  target.exitCode = source.exitCode;
  target.model = source.model;
  target.stopReason = source.stopReason;
  target.errorMessage = source.errorMessage;
}

/**
 * Serialize SubagentSessionData for storage in a custom entry.
 * Data is already JSON-compatible by construction (parsed from child process stdout).
 */
export function serializeSessionData(session: SubagentSessionData): unknown {
  return session;
}

/** Valid session status values */
const VALID_STATUSES = new Set(["running", "completed", "error"]);

/**
 * Check if raw data has valid top-level session fields.
 * Returns the typed record if valid, or null.
 */
function validateSessionShape(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.sessionId !== "string" ||
    typeof d.taskName !== "string" ||
    typeof d.prompt !== "string" ||
    typeof d.status !== "string" ||
    !Array.isArray(d.messages) ||
    d.messages.length > 1000
  ) {
    return null;
  }
  if (!VALID_STATUSES.has(d.status)) return null;
  return d;
}

/**
 * Check that every message in the array has a valid string `role` field.
 */
function validateMessages(messages: unknown[]): boolean {
  for (const msg of messages) {
    if (
      !msg ||
      typeof msg !== "object" ||
      !("role" in msg) ||
      typeof (msg as Record<string, unknown>).role !== "string"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Deserialize and validate session data from a custom entry.
 * Returns null if the data is malformed or missing required fields.
 * Stale "running" sessions (from crashes) are converted to "error" status.
 */
export function deserializeSessionData(data: unknown): SubagentSessionData | null {
  const d = validateSessionShape(data);
  if (!d) return null;
  if (!validateMessages(d.messages as unknown[])) return null;

  const result = d as unknown as SubagentSessionData;

  // Stale "running" sessions from a crash should be marked as "error"
  if (result.status === "running") {
    result.status = "error";
    result.errorMessage =
      result.errorMessage || "Session was interrupted (main agent session ended unexpectedly)";
  }

  return result;
}

// Re-export from format-transcript to maintain backward compatibility
export { formatRunsForResume, getTextContent } from "./format-transcript";

/** Details passed to the UI for rendering sub-agent windows */
export interface WindowedSubagentDetails {
  windows: SubAgentWindow[];
  maxLinesPerWindow: number;
  globalStatus: "running" | "done";
  sessionIds: string[];
}
