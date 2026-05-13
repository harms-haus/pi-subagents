/**
 * pi-subagents Extension
 *
 * Allows the main agent to spawn parallel sub-agents, with each sub-agent's
 * latest output rendered in a rolling TUI window inline with the main agent's
 * conversation history.
 *
 * Supports named profiles configured in settings.json under
 * `subagents.profiles` to pre-configure provider/model, system prompts,
 * thinking levels, and other model settings per profile.
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProfileCommand } from "./commands/profile";
import { registerDelegateTool } from "./tools/delegate";
import { registerRetrievalTools } from "./tools/retrieval";
import type { SubagentSessionData } from "./types";

export default function (pi: ExtensionAPI) {
  // ── In-memory session store ──────────────────────────────────────
  const sessionStore = new Map<string, SubagentSessionData>();
  const MAX_STORED_SESSIONS = 32;

  function registerSession(session: SubagentSessionData): void {
    // Evict oldest sessions when store exceeds limit
    if (sessionStore.size >= MAX_STORED_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, val] of sessionStore) {
        if (val.startedAt < oldestTime) {
          oldestTime = val.startedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) sessionStore.delete(oldestKey);
    }
    sessionStore.set(session.sessionId, session);
  }

  pi.on("session_shutdown", async () => {
    sessionStore.clear();
  });

  // ── Register tools and commands ──────────────────────────────────

  registerDelegateTool(pi, sessionStore, registerSession);
  registerRetrievalTools(pi, sessionStore);
  registerProfileCommand(pi);
}
