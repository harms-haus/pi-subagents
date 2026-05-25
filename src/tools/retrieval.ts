/**
 * Retrieval Tools
 *
 * Tool registrations for retrieving sub-agent output and session data.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadProfiles, profileSummary } from "../profiles";
import { loadMaxLinesPerWindow } from "../settings";
import { getLastAssistantText } from "../utils";
import { formatTranscript, RETRIEVAL_OPTIONS } from "../format-transcript";
import type { SessionRecord } from "../types";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";

// ── Rendering Helpers ───────────────────────────────────────────────────────

/**
 * Simple renderResult that extracts and displays the first text content.
 * Used by list_subagent_profiles (no truncation needed).
 */
function createSimpleRenderResult(defaultLabel: string = "(no output)") {
  return (
    result: AgentToolResult<unknown>,
    _options: { expanded: boolean },
    theme: Theme,
    _context: unknown,
  ) => {
    const text = result.content[0];
    if (!text) return new Text(theme.fg("toolOutput", defaultLabel), 0, 0);
    const content = text.type === "text" ? text.text : defaultLabel;
    return new Text(theme.fg("toolOutput", content), 0, 0);
  };
}

/**
 * Truncating renderResult for sub-agent output/session data.
 * Shows at most maxLinesPerWindow lines with a truncation indicator.
 * The full content is still injected into context; only the TUI display is shortened.
 */
function createTruncatingRenderResult(defaultLabel: string = "(no output)") {
  return (
    result: AgentToolResult<unknown>,
    _options: { expanded: boolean },
    theme: Theme,
    _context: unknown,
  ) => {
    const text = result.content[0];
    if (!text) return new Text(theme.fg("toolOutput", defaultLabel), 0, 0);
    const content = text.type === "text" ? text.text : defaultLabel;
    const lines = content.split("\n");
    const maxLines: number = (result.details as Record<string, unknown>).maxLines as number;

    if (lines.length <= maxLines) {
      return new Text(theme.fg("toolOutput", content), 0, 0);
    }

    const shown = lines.slice(0, maxLines);
    const truncated = lines.length - maxLines;
    const indicator = theme.fg("dim", `... (${truncated} more line${truncated !== 1 ? "s" : ""})`);

    const container = new Container();
    container.addChild(new Text(theme.fg("toolOutput", shown.join("\n")), 0, 0));
    container.addChild(new Text(indicator, 0, 0));
    return container;
  };
}

/**
 * Create a renderCall function for retrieval tools that take a sessionId.
 */
function createSessionRenderCall(toolName: string) {
  return (args: { sessionId?: string }, theme: Theme, _context: unknown) => {
    return new Text(
      theme.fg("toolTitle", theme.bold(`${toolName} `)) +
        theme.fg("accent", args.sessionId ?? "..."),
      0,
      0,
    );
  };
}

// ── Error Constants ─────────────────────────────────────────────────────────

/** Error message when a session ID is not found in the session store. */
function sessionNotFoundMessage(sessionId: string): string {
  return `Session "${sessionId}" not found. The session may have expired or the ID is incorrect.`;
}

/** Shared type for execute context parameter. */
type ToolExecuteContext = ExtensionContext;

/** Look up a session record, throwing if not found or has no runs. */
function requireSession(
  sessionStore: Map<string, SessionRecord>,
  sessionId: string,
): SessionRecord {
  const record = sessionStore.get(sessionId);
  if (!record || record.runs.length === 0) {
    throw new Error(sessionNotFoundMessage(sessionId));
  }
  return record;
}

/** Register the get_subagent_output tool. */
function registerGetSubagentOutput(
  pi: ExtensionAPI,
  sessionStore: Map<string, SessionRecord>,
): void {
  pi.registerTool({
    name: "get_subagent_output",
    label: "Get Sub-agent Output",
    description: [
      "Retrieve the last assistant text output from a completed sub-agent session.",
      "Use this to get the results from a subagent after it finishes, without needing",
      "the subagent to write to a file. Pass the session ID returned by delegate_to_subagents.",
      "For resumed sessions, returns the output from the LATEST run.",
    ].join(" "),
    parameters: Type.Object({
      sessionId: Type.String({ description: "The session ID returned by delegate_to_subagents" }),
    }),
    promptSnippet: "Get the final text output from a previously completed sub-agent session",
    promptGuidelines: [
      "Use get_subagent_output to retrieve the final text output from a sub-agent after",
      "delegate_to_subagents completes, instead of asking the sub-agent to write to a file.",
    ],

    async execute(
      _toolCallId: string,
      params: { sessionId: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ToolExecuteContext,
    ) {
      const record = requireSession(sessionStore, params.sessionId);
      const latestRun = record.runs[record.runs.length - 1];
      if (!latestRun) throw new Error(sessionNotFoundMessage(params.sessionId));
      const lastText = getLastAssistantText(latestRun.messages);
      const maxLines = await loadMaxLinesPerWindow(ctx.cwd);
      return {
        content: [{ type: "text", text: lastText || "(no text output from sub-agent)" }],
        details: {
          sessionId: params.sessionId,
          status: latestRun.status,
          taskName: latestRun.taskName,
          runCount: record.runs.length,
          maxLines,
        },
      };
    },

    renderCall: createSessionRenderCall("get_subagent_output"),
    renderResult: createTruncatingRenderResult("(no output)"),
  });
}

/** Register the get_subagent_session tool. */
function registerGetSubagentSession(
  pi: ExtensionAPI,
  sessionStore: Map<string, SessionRecord>,
): void {
  pi.registerTool({
    name: "get_subagent_session",
    label: "Get Sub-agent Session",
    description: [
      "Retrieve the complete session transcript from a sub-agent, including all messages",
      "(assistant text, tool calls, tool results). Use this for detailed debugging or when",
      "you need the full conversation history of a sub-agent. Pass the session ID returned",
      "by delegate_to_subagents. For resumed sessions, returns ALL runs' data concatenated.",
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

    async execute(
      _toolCallId: string,
      params: { sessionId: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ToolExecuteContext,
    ) {
      const record = requireSession(sessionStore, params.sessionId);
      const transcript = formatTranscript(record.runs, RETRIEVAL_OPTIONS);
      const latestRun = record.runs[record.runs.length - 1];
      if (!latestRun) throw new Error(sessionNotFoundMessage(params.sessionId));
      const maxLines = await loadMaxLinesPerWindow(ctx.cwd);
      return {
        content: [{ type: "text", text: transcript || "(no messages in session)" }],
        details: {
          sessionId: params.sessionId,
          status: latestRun.status,
          taskName: latestRun.taskName,
          messageCount: record.runs.reduce((sum, r) => sum + r.messages.length, 0),
          exitCode: latestRun.exitCode,
          model: latestRun.model,
          runCount: record.runs.length,
          maxLines,
        },
      };
    },

    renderCall: createSessionRenderCall("get_subagent_session"),
    renderResult: createTruncatingRenderResult("(no output)"),
  });
}

/** Register the list_subagent_profiles tool. */
function registerListSubagentProfiles(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "list_subagent_profiles",
    label: "List Sub-agent Profiles",
    description: [
      "List all available subagent profiles that can be used with delegate_to_subagents.",
      "Profiles are stored as .md files in ~/.pi/agent/agent-profiles/ (global) and .pi/agent-profiles/ (project-local).",
    ].join(" "),
    parameters: Type.Object({}),
    promptSnippet: "List available named subagent profiles and their configurations",
    promptGuidelines: [
      "Use list_subagent_profiles to see which profiles are available before choosing",
      "one for delegate_to_subagents.",
    ],

    async execute(
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ToolExecuteContext,
    ) {
      const profiles = loadProfiles(ctx.cwd);
      const names = Object.keys(profiles);
      if (names.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No subagent profiles found. Add .md files to ~/.pi/agent/agent-profiles/ or .pi/agent-profiles/.",
            },
          ],
          details: { count: 0 },
        };
      }
      const summaries = names
        .map((n) => {
          const p = profiles[n];
          return p ? ([n, profileSummary(n, p)] as const) : null;
        })
        .filter((s): s is [string, string] => s !== null);
      return {
        content: [{ type: "text", text: summaries.map(([, s]) => s).join("\n") }],
        details: {
          count: names.length,
          profiles: Object.fromEntries(summaries),
        },
      };
    },

    renderCall(_args: unknown, theme: Theme, _context: unknown) {
      return new Text(theme.fg("toolTitle", theme.bold("list_subagent_profiles")), 0, 0);
    },

    renderResult: createSimpleRenderResult("(no profiles)"),
  });
}

/**
 * Register the retrieval tools: get_subagent_output, get_subagent_session, and list_subagent_profiles.
 */
export function registerRetrievalTools(
  pi: ExtensionAPI,
  sessionStore: Map<string, SessionRecord>,
): void {
  registerGetSubagentOutput(pi, sessionStore);
  registerGetSubagentSession(pi, sessionStore);
  registerListSubagentProfiles(pi);
}
