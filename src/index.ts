/**
 * pi-subagents Extension
 *
 * Allows the main agent to spawn parallel sub-agents, with each sub-agent's
 * latest output rendered in a rolling TUI window inline with the main agent's
 * conversation history.
 *
 * Supports named profiles defined as markdown files in the
 * agent-profiles/ directory, each pre-configuring provider/model, system
 * prompts, thinking levels, and other model settings per profile.
 *
 * Tools provided:
 *   delegate_to_subagents — spawn parallel sub-agents
 *   get_subagent_output   — retrieve last assistant text from a sub-agent session
 *   get_subagent_session  — retrieve full session transcript from a sub-agent
 *   list_subagent_profiles — list available named profiles
 *
 * Usage (from the LLM):
 *   delegate_to_subagents({ tasks: [{ name: "test", prompt: "...", profile: "code-reviewer" }] })
 *   get_subagent_output({ sessionId: "abc12345def45678" })
 *   get_subagent_session({ sessionId: "abc12345def45678" })
 *   list_subagent_profiles({})
 */

import { registerProfileCommand } from "./commands/profile";
import { registerDelegateTool } from "./tools/delegate";
import { registerRetrievalTools } from "./tools/retrieval";
import { CUSTOM_ENTRY_TYPE, deserializeSessionData } from "./types";
import type { SessionRecord, SubagentSessionData } from "./types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // ── In-memory session store ──────────────────────────────────────
  const sessionStore = new Map<string, SessionRecord>();
  const MAX_STORED_SESSIONS = 32;
  const MAX_RUNS_PER_SESSION = 10;

  function registerSession(session: SubagentSessionData): void {
    const existing = sessionStore.get(session.sessionId);
    if (existing) {
      // Resume: append to existing record
      existing.runs.push(session);
      // Cap runs per session to prevent unbounded memory growth
      while (existing.runs.length > MAX_RUNS_PER_SESSION) {
        existing.runs.shift();
      }
    } else {
      // New session: create a new record
      if (sessionStore.size >= MAX_STORED_SESSIONS) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, val] of sessionStore) {
          // Skip sessions with running tasks — don't evict active sessions
          if (val.runs.some((r) => r.status === "running")) continue;
          const firstRun = val.runs[0];
          if (firstRun && firstRun.startedAt < oldestTime) {
            oldestTime = firstRun.startedAt;
            oldestKey = key;
          }
        }
        if (oldestKey) {
          sessionStore.delete(oldestKey);
        }
      }
      sessionStore.set(session.sessionId, { runs: [session] });
    }
  }

  function getActiveSessionIds(): Set<string> {
    const active = new Set<string>();
    for (const [, record] of sessionStore) {
      if (record.runs.some((r) => r.status === "running")) {
        const firstRun = record.runs[0];
        if (firstRun) {
          active.add(firstRun.sessionId);
        }
      }
    }
    return active;
  }

  // Reconstruct session store from persisted custom entries on session load
  pi.on("session_start", (event, ctx) => {
    // New sessions have no prior data to reconstruct
    if (event.reason === "new") {
      return;
    }

    try {
      const entries = ctx.sessionManager.getEntries();
      for (const entry of entries) {
        if (
          entry.type === "custom" &&
          "customType" in entry &&
          entry.customType === CUSTOM_ENTRY_TYPE
        ) {
          const sessionData = deserializeSessionData(entry.data);
          if (sessionData) {
            registerSession(sessionData);
          }
        }
      }
    } catch (err) {
      console.warn("[pi-subagents] Failed to reconstruct session data:", err);
    }
  });

  pi.on("session_shutdown", () => {
    sessionStore.clear();
  });

  // ── Register tools and commands ──────────────────────────────────

  registerDelegateTool(pi, sessionStore, registerSession, getActiveSessionIds);
  registerRetrievalTools(pi, sessionStore);
  registerProfileCommand(pi);
}
