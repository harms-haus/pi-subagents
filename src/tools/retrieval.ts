/**
 * Retrieval Tools
 *
 * Tool registrations for retrieving sub-agent output and session data.
 */

import type { ExtensionAPI, Theme, ToolExecutionResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadProfiles, profileSummary } from "../profiles";
import type { SubagentSessionData, ToolCallPart } from "../types";
import { getLastAssistantText, getTextParts } from "../utils";

// ── Rendering Helpers ───────────────────────────────────────────────────────

/**
 * Simple renderResult that extracts and displays the first text content.
 * Used by get_subagent_output, get_subagent_session, and list_subagent_profiles.
 */
function createSimpleRenderResult(defaultLabel: string = "(no output)") {
  return (result: ToolExecutionResult, _options: { expanded: boolean }, theme: Theme, _context: unknown) => {
    const text = result.content[0];
    const content = text?.type === "text" ? text.text : defaultLabel;
    return new Text(theme.fg("toolOutput", content), 0, 0);
  };
}

/**
 * Create a renderCall function for retrieval tools that take a sessionId.
 */
function createSessionRenderCall(toolName: string) {
  return (args: { sessionId?: string }, theme: Theme, _context: unknown) => {
    return new Text(
      theme.fg("toolTitle", theme.bold(`${toolName} `)) + theme.fg("accent", args.sessionId ?? "..."),
      0,
      0,
    );
  };
}

// ── Error Constants ─────────────────────────────────────────────────────────

/** Error message when a session ID is not found in the session store. */
const SESSION_NOT_FOUND_ERROR = (sessionId: string) =>
  `Session "${sessionId}" not found. The session may have expired or the ID is incorrect.`;

/**
 * Register the retrieval tools: get_subagent_output, get_subagent_session, and list_subagent_profiles.
 */
export function registerRetrievalTools(pi: ExtensionAPI, sessionStore: Map<string, SubagentSessionData>): void {
  // ── Tool: get_subagent_output ───────────────────────────────────

  pi.registerTool({
    name: "get_subagent_output",
    label: "Get Sub-agent Output",
    description: [
      "Retrieve the last assistant text output from a completed sub-agent session.",
      "Use this to get the results from a subagent after it finishes, without needing",
      "the subagent to write to a file. Pass the session ID returned by delegate_to_subagents.",
    ].join(" "),
    parameters: Type.Object({
      sessionId: Type.String({ description: "The session ID returned by delegate_to_subagents" }),
    }),
    promptSnippet: "Get the final text output from a previously completed sub-agent session",
    promptGuidelines: [
      "Use get_subagent_output to retrieve the final text output from a sub-agent after",
      "delegate_to_subagents completes, instead of asking the sub-agent to write to a file.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const session = sessionStore.get(params.sessionId);
      if (!session) {
        throw new Error(SESSION_NOT_FOUND_ERROR(params.sessionId));
      }

      const lastText = getLastAssistantText(session.messages);
      return {
        content: [{ type: "text", text: lastText || "(no text output from sub-agent)" }],
        details: {
          sessionId: params.sessionId,
          status: session.status,
          taskName: session.taskName,
        },
      };
    },

    renderCall: createSessionRenderCall("get_subagent_output"),
    renderResult: createSimpleRenderResult("(no output)"),
  });

  // ── Tool: get_subagent_session ──────────────────────────────────

  pi.registerTool({
    name: "get_subagent_session",
    label: "Get Sub-agent Session",
    description: [
      "Retrieve the complete session transcript from a sub-agent, including all messages",
      "(assistant text, tool calls, tool results). Use this for detailed debugging or when",
      "you need the full conversation history of a sub-agent. Pass the session ID returned",
      "by delegate_to_subagents.",
    ].join(" "),
    parameters: Type.Object({
      sessionId: Type.String({ description: "The session ID returned by delegate_to_subagents" }),
    }),
    promptSnippet: "Read the full session transcript from a previously completed sub-agent session",
    promptGuidelines: [
      "Use get_subagent_session when you need the FULL conversation history of a sub-agent,",
      "including all tool calls and results. Use get_subagent_output instead when you only",
      "need the final output.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const session = sessionStore.get(params.sessionId);
      if (!session) {
        throw new Error(SESSION_NOT_FOUND_ERROR(params.sessionId));
      }

      const parts: string[] = [];
      for (const msg of session.messages) {
        // Extract text parts using the helper
        const textParts = getTextParts(msg);
        for (const text of textParts) {
          parts.push(text);
        }

        // Extract tool calls
        if (msg.role === "assistant" && msg.content) {
          for (const part of msg.content) {
            if (part.type === "toolCall") {
              const args = (part as ToolCallPart).arguments || {};
              const preview = JSON.stringify(args).slice(0, 120);
              parts.push(`→ ${(part as ToolCallPart).name}: ${preview}`);
            }
          }
        } else if (msg.role === "toolResult" && msg.content) {
          for (const part of msg.content) {
            if (part.type === "text") {
              const text = part.text;
              if (text.length > 500) {
                parts.push(`[tool result]: ${text.slice(0, 500)}...`);
              } else {
                parts.push(`[tool result]: ${text}`);
              }
            }
          }
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n---\n") || "(no messages in session)" }],
        details: {
          sessionId: params.sessionId,
          status: session.status,
          taskName: session.taskName,
          messageCount: session.messages.length,
          exitCode: session.exitCode,
          model: session.model,
        },
      };
    },

    renderCall: createSessionRenderCall("get_subagent_session"),
    renderResult: createSimpleRenderResult("(no output)"),
  });

  // ── Tool: list_subagent_profiles ────────────────────────────────

  pi.registerTool({
    name: "list_subagent_profiles",
    label: "List Sub-agent Profiles",
    description: [
      "List all available subagent profiles that can be used with delegate_to_subagents.",
      "Profiles are configured in settings.json under subagents.profiles.",
    ].join(" "),
    parameters: Type.Object({}),
    promptSnippet: "List available named subagent profiles and their configurations",
    promptGuidelines: [
      "Use list_subagent_profiles to see which profiles are available before choosing",
      "one for delegate_to_subagents.",
    ],

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const profiles = await loadProfiles(ctx.cwd);
      const names = Object.keys(profiles);
      if (names.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No subagent profiles defined. Add profiles to settings.json under subagents.profiles.",
            },
          ],
          details: { count: 0 },
        };
      }
      const summaries = names.map((n) => [n, profileSummary(n, profiles[n])] as const);
      return {
        content: [{ type: "text", text: summaries.map(([, s]) => s).join("\n") }],
        details: {
          count: names.length,
          profiles: Object.fromEntries(summaries),
        },
      };
    },

    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("list_subagent_profiles")), 0, 0);
    },

    renderResult: createSimpleRenderResult("(no profiles)"),
  });
}
