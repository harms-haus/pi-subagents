/**
 * Shared type definitions for the delegate tool split modules.
 *
 * This file contains only type definitions and interfaces that are
 * shared across delegate-*.ts modules to avoid circular dependencies.
 */

import type { SubagentProfile } from "../profile-types";
import type { SessionRecord, SubAgentTask, SubAgentWindow, SubagentSessionData } from "../types";

// ── Parameter Types ───────────────────────────────────────────────────

/** Inferred type from the DelegateParams schema */
export type StaticDelegateParams = {
  tasks: SubAgentTask[];
  profile?: string;
};

// ── Profile Resolution Types ──────────────────────────────────────────

/** Resolved profile data for a single task */
export type ResolvedProfileEntry = { name?: string; profile?: SubagentProfile };

/** Result of resolving all task profiles, skills, and tool allowlists */
export interface ProfileResolutionResult {
  profiles: Record<string, SubagentProfile>;
  resolvedProfiles: ResolvedProfileEntry[];
  skillResolvedProfiles: Map<
    SubagentProfile,
    { ok: true; profile: SubagentProfile } | { ok: false; error: string }
  >;
  allToolNames: string[] | undefined;
  agentDir: string;
}

// ── Task Execution Types ──────────────────────────────────────────────

/** Shared context for running a single sub-agent task */
export interface TaskRunContext {
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
