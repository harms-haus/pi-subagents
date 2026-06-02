import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadProfiles, profileSummary } from "../profiles";
import { registerRetrievalTools } from "../tools/retrieval";
import type { SessionRecord } from "../types";
import { createMockPi, createMockTheme, makeSession } from "./helpers";

// Mock the TUI components (same pattern as tools.test.ts)
vi.mock("@earendil-works/pi-tui", () => ({
  Text: vi.fn().mockImplementation(function (this: any, text: string) {
    this.text = text;
  }),
  Container: vi.fn().mockImplementation(function (this: any) {
    this.addChild = vi.fn();
  }),
  Spacer: vi.fn().mockImplementation(function (this: any) {
    this.spacer = true;
  }),
}));

// Mock the AI types
vi.mock("@earendil-works/pi-ai", () => ({
  Message: {},
}));

// Mock TypeBox
vi.mock("typebox", () => ({
  Type: {
    Object: vi.fn(() => ({})),
    String: vi.fn(() => ({})),
    Number: vi.fn(() => ({})),
    Optional: vi.fn((fn: unknown) => fn),
    Array: vi.fn(() => ({})),
  },
}));

// Mock the profiles module
vi.mock("../profiles", () => ({
  loadProfiles: vi.fn().mockReturnValue({}),
  resolveProfile: vi.fn(),
  profileSummary: vi.fn().mockReturnValue("profile-summary"),
  validateProfileTools: vi.fn(),
  applyExcludeTools: vi.fn(),
}));

// Mock the settings module
vi.mock("../settings", () => ({
  loadMaxLinesPerWindow: vi.fn().mockResolvedValue(15),
  loadExtendTimeoutDebounce: vi.fn().mockResolvedValue(30),
  loadLoopingToolCount: vi.fn().mockResolvedValue(5),
}));

// ── Helpers ───────────────────────────────────────────────────────────

/** Extract a registered tool's execute function by name */
function getToolExecute(mockPi: ExtensionAPI, toolName: string) {
  const call = vi
    .mocked(mockPi.registerTool)
    .mock.calls.find((c: [{ name: string }]) => c[0].name === toolName);
  if (!call) {
    throw new Error(`Tool "${toolName}" not registered`);
  }
  return call[0].execute;
}

/** Extract a registered tool's renderResult function by name */
function getToolRenderResult(mockPi: ExtensionAPI, toolName: string) {
  const call = vi
    .mocked(mockPi.registerTool)
    .mock.calls.find((c: [{ name: string }]) => c[0].name === toolName);
  if (!call) {
    throw new Error(`Tool "${toolName}" not registered`);
  }
  const renderResult = call[0].renderResult;
  if (!renderResult) {
    throw new Error(`Tool "${toolName}" has no renderResult`);
  }
  return renderResult;
}

/** Extract a registered tool's renderCall function by name */
function getToolRenderCall(mockPi: ExtensionAPI, toolName: string) {
  const call = vi
    .mocked(mockPi.registerTool)
    .mock.calls.find((c: [{ name: string }]) => c[0].name === toolName);
  if (!call) {
    throw new Error(`Tool "${toolName}" not registered`);
  }
  const renderCall = call[0].renderCall;
  if (!renderCall) {
    throw new Error(`Tool "${toolName}" has no renderCall`);
  }
  return renderCall;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("retrieval-tools", () => {
  let mockPi: ExtensionAPI;
  let sessionStore: Map<string, SessionRecord>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPi = createMockPi();
    sessionStore = new Map();
  });

  // ── list_subagent_profiles execute ──────────────────────────────────

  describe("list_subagent_profiles execute", () => {
    it("returns empty message when no profiles", async () => {
      vi.mocked(loadProfiles).mockReturnValueOnce({});

      registerRetrievalTools(mockPi, sessionStore);
      const execute = getToolExecute(mockPi, "list_subagent_profiles");

      const result = await execute("tc-id", {}, undefined, vi.fn(), { cwd: "/tmp" } as any);

      expect(result.content).toEqual([
        {
          type: "text" as const,
          text: "No subagent profiles found. Add .md files to ~/.pi/agent/agent-profiles/ or .pi/agent-profiles/.",
        },
      ]);
      expect(result.details).toEqual({ count: 0 });
    });

    it("returns summaries when profiles exist", async () => {
      vi.mocked(loadProfiles).mockReturnValueOnce({
        coder: { model: "claude-sonnet-4-5" },
        reviewer: { model: "gpt-4o" },
      });
      vi.mocked(profileSummary)
        .mockReturnValueOnce("coder: claude-sonnet-4-5")
        .mockReturnValueOnce("reviewer: gpt-4o");

      registerRetrievalTools(mockPi, sessionStore);
      const execute = getToolExecute(mockPi, "list_subagent_profiles");

      const result = await execute("tc-id", {}, undefined, vi.fn(), { cwd: "/tmp" } as any);

      expect(result.content[0]!.type).toBe("text");
      expect((result.content[0]! as { text: string }).text).toContain("coder: claude-sonnet-4-5");
      expect((result.content[0]! as { text: string }).text).toContain("reviewer: gpt-4o");
      expect((result.details as any).count).toBe(2);
      expect((result.details as any).profiles).toEqual({
        coder: "coder: claude-sonnet-4-5",
        reviewer: "reviewer: gpt-4o",
      });
    });
  });

  // ── createTruncatingRenderResult ────────────────────────────────────

  describe("createTruncatingRenderResult", () => {
    it("shows full content when under maxLines", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderResult = getToolRenderResult(mockPi, "get_subagent_output");
      const theme = createMockTheme();

      // 3 lines of content, details.maxLines defaults to 15
      const shortContent = "line1\nline2\nline3";
      const result = {
        content: [{ type: "text" as const, text: shortContent }],
        details: { maxLines: 15 },
      };

      renderResult(result, { expanded: false, isPartial: false }, theme, null as any);

      // Should render full content via Text (not Container)
      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("toolOutput", shortContent);
    });

    it("truncates with indicator when over maxLines", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderResult = getToolRenderResult(mockPi, "get_subagent_output");
      const theme = createMockTheme();

      // Create 20 lines of content with maxLines = 5
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      const fullContent = lines.join("\n");
      const result = {
        content: [{ type: "text" as const, text: fullContent }],
        details: { maxLines: 5 },
      };

      const output = renderResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        null as any,
      );

      // Should return a Container (for truncation layout)
      expect(output).toHaveProperty("addChild");
      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("toolOutput", lines.slice(0, 5).join("\n"));
      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("dim", "... (15 more lines)");
    });

    it("handles non-text content (default label)", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderResult = getToolRenderResult(mockPi, "get_subagent_output");
      const theme = createMockTheme();

      // Content with no text type
      const result = {
        content: [{} as { type: string }],
        details: { maxLines: 15 },
      };

      renderResult(result as any, { expanded: false, isPartial: false }, theme, null as any);

      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("toolOutput", "(no output)");
    });
  });

  // ── get_subagent_session - toolResult extraction ────────────────────

  describe("get_subagent_session - toolResult extraction", () => {
    it("extracts toolResult content properly", async () => {
      registerRetrievalTools(mockPi, sessionStore);

      const session = makeSession({
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "Tool returned successfully" }],
          } as unknown as Message,
        ],
      });
      sessionStore.set("s1", { runs: [session] });

      const execute = getToolExecute(mockPi, "get_subagent_session");
      const result = await execute("tc-id", { sessionId: "s1" }, undefined, vi.fn(), {
        cwd: "/tmp",
      } as any);

      expect((result.content[0]! as { text: string }).text).toContain(
        "[tool result]: Tool returned successfully",
      );
    });

    it("truncates tool results > 500 chars", async () => {
      registerRetrievalTools(mockPi, sessionStore);

      const longText = "x".repeat(600);
      const session = makeSession({
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: longText }],
          } as unknown as Message,
        ],
      });
      sessionStore.set("s1", { runs: [session] });

      const execute = getToolExecute(mockPi, "get_subagent_session");
      const result = await execute("tc-id", { sessionId: "s1" }, undefined, vi.fn(), {
        cwd: "/tmp",
      } as any);

      const outputText = (result.content[0]! as { text: string }).text;
      // Should contain truncated text (500 chars + "...")
      expect(outputText).toContain("...");
      const match = outputText.match(/\[tool result\]: (.+)\.\.\./);
      expect(match).not.toBeNull();
      expect(match?.[1]?.length).toBe(500);
    });

    it("handles missing toolResult content", async () => {
      registerRetrievalTools(mockPi, sessionStore);

      // toolResult message with non-text content
      const session = makeSession({
        messages: [
          {
            role: "toolResult",
            content: [{ type: "image" as const, data: "", mimeType: "image/png" }],
          } as unknown as Message,
        ],
      });
      sessionStore.set("s1", { runs: [session] });

      const execute = getToolExecute(mockPi, "get_subagent_session");
      const result = await execute("tc-id", { sessionId: "s1" }, undefined, vi.fn(), {
        cwd: "/tmp",
      } as any);

      // No text part in toolResult — content should reflect empty messages
      expect((result.content[0]! as { text: string }).text).toContain("(no messages in session)");
    });
  });

  // ── get_subagent_output - edge cases ────────────────────────────────

  describe("get_subagent_output - edge cases", () => {
    it("returns details with runCount for multi-run session", async () => {
      registerRetrievalTools(mockPi, sessionStore);

      const run1 = makeSession({
        sessionId: "multi",
        taskName: "task-1",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text" as const, text: "Run 1 output" }],
          } as unknown as Message,
        ],
      });
      const run2 = makeSession({
        sessionId: "multi",
        taskName: "task-2",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text" as const, text: "Run 2 output" }],
          } as unknown as Message,
        ],
      });
      const run3 = makeSession({
        sessionId: "multi",
        taskName: "task-3",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text" as const, text: "Run 3 output" }],
          } as unknown as Message,
        ],
      });
      sessionStore.set("multi", { runs: [run1, run2, run3] });

      const execute = getToolExecute(mockPi, "get_subagent_output");
      const result = await execute("tc-id", { sessionId: "multi" }, undefined, vi.fn(), {
        cwd: "/tmp",
      } as any);

      // Should return latest (3rd) run output
      expect((result.content[0]! as { text: string }).text).toBe("Run 3 output");
      expect((result.details as any).runCount).toBe(3);
      expect((result.details as any).sessionId).toBe("multi");
      expect((result.details as any).status).toBe("completed");
      expect((result.details as any).taskName).toBe("task-3");
    });

    it("handles session with only toolCall messages (no text)", async () => {
      registerRetrievalTools(mockPi, sessionStore);

      // Session with tool calls but no assistant text output
      const session = makeSession({
        sessionId: "tools-only",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "bash",
                arguments: { command: "ls" },
                id: "tc-1",
              } as const,
            ],
          } as unknown as Message,
          {
            role: "toolResult",
            content: [{ type: "text" as const, text: "file1.txt\nfile2.txt" }],
          } as unknown as Message,
        ],
      });
      sessionStore.set("tools-only", { runs: [session] });

      const execute = getToolExecute(mockPi, "get_subagent_output");
      const result = await execute("tc-id", { sessionId: "tools-only" }, undefined, vi.fn(), {
        cwd: "/tmp",
      } as any);

      // No assistant text → placeholder message
      expect((result.content[0]! as { text: string }).text).toBe("(no text output from sub-agent)");
    });
  });

  // ── get_subagent_session - errorMessage branch ─────────────────────

  describe("get_subagent_session - errorMessage branch", () => {
    it("should include error message when run has status error and errorMessage", async () => {
      registerRetrievalTools(mockPi, sessionStore);

      const session = makeSession({
        sessionId: "error-session",
        status: "error",
        errorMessage: "something broke",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text" as const, text: "Partial response" }],
          } as unknown as Message,
        ],
      });
      sessionStore.set("error-session", { runs: [session] });

      const execute = getToolExecute(mockPi, "get_subagent_session");
      const result = await execute("tc-id", { sessionId: "error-session" }, undefined, vi.fn(), {
        cwd: "/tmp",
      } as any);

      const text = (result.content[0]! as { text: string }).text;
      expect(text).toContain("Partial response");
      expect(text).toContain("[Error: something broke]");
    });
  });

  // ── createSimpleRenderResult (used by list_subagent_profiles) ──────

  describe("createSimpleRenderResult", () => {
    it("returns default label when content array is empty", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderResult = getToolRenderResult(mockPi, "list_subagent_profiles");
      const theme = createMockTheme();

      const result = {
        content: [] as Array<{ type: string; text: string }>,
        details: {},
      };

      renderResult(result as any, { expanded: false, isPartial: false }, theme, null as any);

      // Should have returned a Text with the default label
      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("toolOutput", "(no profiles)");
    });

    it("returns default label when content type is not text", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderResult = getToolRenderResult(mockPi, "list_subagent_profiles");
      const theme = createMockTheme();

      const result = {
        content: [{ type: "image", data: "..." }] as any,
        details: {},
      };

      renderResult(result, { expanded: false, isPartial: false }, theme, null as any);

      // Should have returned a Text with the default label since type !== "text"
      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("toolOutput", "(no profiles)");
    });

    it("returns text content when content type is text", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderResult = getToolRenderResult(mockPi, "list_subagent_profiles");
      const theme = createMockTheme();

      const result = {
        content: [{ type: "text", text: "coder: claude-sonnet-4-5" }],
        details: {},
      };

      renderResult(result as any, { expanded: false, isPartial: false }, theme, null as any);

      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("toolOutput", "coder: claude-sonnet-4-5");
    });
  });

  // ── createSessionRenderCall ─────────────────────────────────────────

  describe("createSessionRenderCall", () => {
    it("renders with sessionId when provided", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderCall = getToolRenderCall(mockPi, "get_subagent_output");
      const theme = createMockTheme();

      renderCall({ sessionId: "abc-123" }, theme, null as any);

      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("accent", "abc-123");
    });

    it("renders with placeholder when sessionId is undefined", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderCall = getToolRenderCall(mockPi, "get_subagent_output");
      const theme = createMockTheme();

      renderCall({}, theme, null as any);

      // Should use "..." when sessionId is not provided
      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("accent", "...");
    });
  });

  // ── list_subagent_profiles renderCall ───────────────────────────────

  describe("list_subagent_profiles renderCall", () => {
    it("renders tool title", () => {
      registerRetrievalTools(mockPi, sessionStore);
      const renderCall = getToolRenderCall(mockPi, "list_subagent_profiles");
      const theme = createMockTheme();

      renderCall({}, theme, null as any);

      expect(vi.mocked(theme.fg)).toHaveBeenCalledWith("toolTitle", expect.any(String));
      expect(vi.mocked(theme.bold)).toHaveBeenCalledWith("list_subagent_profiles");
    });
  });
});
