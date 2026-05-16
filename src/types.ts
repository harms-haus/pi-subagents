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

// Re-export from format-transcript to maintain backward compatibility
export { formatRunsForResume, getTextContent } from "./format-transcript";

/** Details passed to the UI for rendering sub-agent windows */
export interface WindowedSubagentDetails {
  windows: SubAgentWindow[];
  maxLinesPerWindow: number;
  globalStatus: "running" | "done";
  sessionIds: string[];
}
