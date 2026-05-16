import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDelegateTool } from "../tools/delegate";
import type { SessionRecord } from "../types";
import { createMockTheme, makeDetails, makeWindow } from "./helpers";

// Mock the TUI components — same pattern as tools.test.ts
vi.mock("@earendil-works/pi-tui", () => ({
  Text: vi.fn().mockImplementation((text: string) => ({ text })),
  Container: vi.fn().mockImplementation(() => ({
    addChild: vi.fn(),
  })),
  Spacer: vi.fn().mockImplementation(() => ({ spacer: true })),
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

// Mock the spawner
vi.mock("../spawner", () => ({
  runSubAgent: vi.fn().mockResolvedValue(undefined),
}));

// Mock the profiles module
vi.mock("../profiles", () => ({
  loadProfiles: vi.fn().mockResolvedValue({}),
  resolveProfile: vi.fn(),
  profileSummary: vi.fn().mockReturnValue("profile-summary"),
  validateProfileTools: vi.fn(),
  applyExcludeTools: vi.fn(),
}));

// Mock the settings module
vi.mock("../settings", () => ({
  loadMaxLinesPerWindow: vi.fn().mockResolvedValue(15),
}));

// ── Helpers ────────────────────────────────────────────────────────

/** Register the delegate tool and return its renderCall + renderResult functions */
function getRenderFunctions() {
  const mockPi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
  } as unknown as ExtensionAPI;

  const sessionStore = new Map<string, SessionRecord>();
  const mockRegisterSession = vi.fn();
  const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

  registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

  const toolRegistration = vi
    .mocked(mockPi.registerTool)
    .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
  expect(toolRegistration).toBeDefined();

  return {
    renderCall: toolRegistration![0].renderCall,
    renderResult: toolRegistration![0].renderResult,
  };
}

/** Creates a theme mock that records calls and returns the text unchanged */
const makeMockTheme = createMockTheme;

/** Get the container instance from the last Container mock call */
function getLastContainerInstance() {
  const MockContainer = vi.mocked(Container);
  return MockContainer.mock.results[MockContainer.mock.results.length - 1].value;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("delegate_to_subagents render functions", () => {
  let renderCall: NonNullable<ReturnType<typeof getRenderFunctions>["renderCall"]>;
  let renderResult: NonNullable<ReturnType<typeof getRenderFunctions>["renderResult"]>;
  let theme: Theme;

  beforeEach(() => {
    const fns = getRenderFunctions();
    renderCall = fns.renderCall as typeof renderCall;
    renderResult = fns.renderResult as typeof renderResult;
    theme = makeMockTheme();
  });

  // ── renderCall ─────────────────────────────────────────────────

  describe("renderCall", () => {
    it("renders with single task, no profile", () => {
      const result = renderCall(
        { tasks: [{ name: "build", prompt: "build the project" }] },
        theme,
        null as unknown as any,
      );

      // Should be a Text instance with the right content
      expect(result).toEqual({ text: expect.any(String) });
      const text = (result as unknown as { text: string }).text;

      expect(text).toContain("delegate_to_subagents");
      expect(text).toContain("1 sub-agent");
      expect(text).not.toContain("default profile");
      expect(text).not.toContain("profiles:");
    });

    it("renders with multiple tasks", () => {
      const result = renderCall(
        {
          tasks: [
            { name: "build", prompt: "build it" },
            { name: "test", prompt: "test it" },
            { name: "lint", prompt: "lint it" },
          ],
        },
        theme,
        null as unknown as any,
      );

      const text = (result as unknown as { text: string }).text;
      expect(text).toContain("3 sub-agents");
    });

    it("renders with default profile", () => {
      const result = renderCall(
        {
          tasks: [{ name: "build", prompt: "build it" }],
          profile: "researcher",
        },
        theme,
        null as unknown as any,
      );

      const text = (result as unknown as { text: string }).text;
      expect(text).toContain("default profile: researcher");
    });

    it("renders with per-task profiles", () => {
      const result = renderCall(
        {
          tasks: [
            { name: "build", prompt: "build it", profile: "code-reviewer" },
            { name: "test", prompt: "test it", profile: "researcher" },
          ],
        },
        theme,
        null as unknown as any,
      );

      const text = (result as unknown as { text: string }).text;
      expect(text).toContain("profiles: [code-reviewer, researcher]");
    });
  });

  // ── renderResult ───────────────────────────────────────────────

  describe("renderResult", () => {
    it("renders when no details provided", () => {
      const result = renderResult(
        { content: [{ type: "text", text: "done" }] } as any,
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      // Without details it should return a simple Text
      expect(result).toEqual({ text: "(no sub-agent details)" });
    });

    it("renders global status header (running/done/errors)", () => {
      const details = makeDetails({
        windows: [
          makeWindow({ name: "task-1", status: "running" }),
          makeWindow({ name: "task-2", status: "completed", sessionId: "session-2" }),
          makeWindow({ name: "task-3", status: "error", sessionId: "session-3" }),
        ],
        maxLinesPerWindow: 15,
        globalStatus: "running",
        sessionIds: ["session-abc123", "session-2", "session-3"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      // The theme.fg should have been called with status counts
      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      expect(allFgText).toContain("1 running");
      expect(allFgText).toContain("1 done");
      expect(allFgText).toContain("1 error");
    });

    it("renders per-agent windows with running status", () => {
      const details = makeDetails({
        windows: [makeWindow({ name: "running-task", status: "running" })],
        maxLinesPerWindow: 15,
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      // Running status uses ⏳ icon and "warning" color
      expect(allFgText).toContain("⏳");
      expect(allFgText).toContain("running-task");
    });

    it("renders per-agent windows with completed status", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "done-task",
            status: "completed",
            sessionId: "session-done",
          }),
        ],
        maxLinesPerWindow: 15,
        globalStatus: "done",
        sessionIds: ["session-done"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      expect(allFgText).toContain("✓");
      expect(allFgText).toContain("done-task");
    });

    it("renders per-agent windows with error status and error message", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "fail-task",
            status: "error",
            errorMessage: "Process exited with code 1",
            sessionId: "session-err",
          }),
        ],
        maxLinesPerWindow: 15,
        globalStatus: "done",
        sessionIds: ["session-err"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      expect(allFgText).toContain("✗");
      expect(allFgText).toContain("fail-task");
      expect(allFgText).toContain("Error: Process exited with code 1");
    });

    it("renders collapsed mode (rolling window - win.lines)", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "task-collapsed",
            status: "running",
            lines: [
              { text: "line 1 output", kind: "text" },
              { text: "tool invocation", kind: "tool" },
            ],
          }),
        ],
        maxLinesPerWindow: 15,
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      // A Container should have been created
      const MockContainer = vi.mocked(Container);
      expect(MockContainer).toHaveBeenCalled();
      const containerInstance = getLastContainerInstance();
      const addChildCalls = vi.mocked(containerInstance.addChild).mock.calls;

      // The lines should be rendered as children (filter out Spacers which have no text)
      const allTexts = addChildCalls
        .map((c: [unknown]) => (c[0] as { text?: string }).text)
        .filter((t: unknown): t is string => typeof t === "string");
      expect(allTexts.some((t: string) => t.includes("line 1 output"))).toBe(true);

      // Tool lines should use "muted" color
      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const mutedCalls = fgCalls.filter((c: [string, string]) => c[0] === "muted");
      expect(mutedCalls.some((c: [string, string]) => (c[1] as string).includes("tool invocation"))).toBe(true);
    });

    it("renders expanded mode (all messages - win.allMessages)", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "task-expanded",
            status: "completed",
            lines: [{ text: "rolling line", kind: "text" }],
            allMessages: [
              { text: "first message", kind: "text" },
              { text: "second message", kind: "text" },
              { text: "third message", kind: "text" },
            ],
            sessionId: "session-exp",
          }),
        ],
        maxLinesPerWindow: 15,
        globalStatus: "done",
        sessionIds: ["session-exp"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: true },
        theme,
        null as unknown as any,
      );

      const MockContainer = vi.mocked(Container);
      expect(MockContainer).toHaveBeenCalled();
      const containerInstance = getLastContainerInstance();
      const addChildCalls = vi.mocked(containerInstance.addChild).mock.calls;

      const allTexts = addChildCalls
        .map((c: [unknown]) => (c[0] as { text?: string }).text)
        .filter((t: unknown): t is string => typeof t === "string");

      // Should show allMessages content, not just lines
      expect(allTexts.some((t: string) => t.includes("first message"))).toBe(true);
      expect(allTexts.some((t: string) => t.includes("second message"))).toBe(true);
      expect(allTexts.some((t: string) => t.includes("third message"))).toBe(true);
    });

    it("renders footer with session IDs when done", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "task-a",
            status: "completed",
            sessionId: "sid-aaa",
          }),
          makeWindow({
            name: "task-b",
            status: "completed",
            sessionId: "sid-bbb",
          }),
        ],
        maxLinesPerWindow: 15,
        globalStatus: "done",
        sessionIds: ["sid-aaa", "sid-bbb"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const MockContainer = vi.mocked(Container);
      expect(MockContainer).toHaveBeenCalled();
      const containerInstance = getLastContainerInstance();
      const addChildCalls = vi.mocked(containerInstance.addChild).mock.calls;

      const allTexts = addChildCalls
        .map((c: [unknown]) => (c[0] as { text?: string }).text)
        .filter((t: unknown): t is string => typeof t === "string");

      // Footer should contain session IDs
      expect(allTexts.some((t: string) => t.includes("Session IDs"))).toBe(true);
      expect(allTexts.some((t: string) => t.includes("sid-aaa"))).toBe(true);
      expect(allTexts.some((t: string) => t.includes("sid-bbb"))).toBe(true);
    });

    it('renders "running..." footer when still running', () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "slow-task",
            status: "running",
            sessionId: "sid-slow",
          }),
        ],
        maxLinesPerWindow: 15,
        globalStatus: "running",
        sessionIds: ["sid-slow"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const MockContainer = vi.mocked(Container);
      expect(MockContainer).toHaveBeenCalled();
      const containerInstance = getLastContainerInstance();
      const addChildCalls = vi.mocked(containerInstance.addChild).mock.calls;

      const allTexts = addChildCalls
        .map((c: [unknown]) => (c[0] as { text?: string }).text)
        .filter((t: unknown): t is string => typeof t === "string");

      expect(allTexts.some((t: string) => t.includes("running..."))).toBe(true);
      // Should NOT show session ID footer while running
      expect(allTexts.some((t: string) => t.includes("Session IDs"))).toBe(false);
    });

    // ── New header format tests ────────────────────────────────────

    it("renders condensed header with all fields present", () => {
      const fixedStart = Date.now() - 45_000; // 45 seconds ago
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "full-header-task",
            status: "running",
            profileName: "researcher",
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            thinkingLevel: "high",
            toolCount: 7,
            todoTotal: 5,
            todoCompleted: 2,
            startedAt: fixedStart,
            timeout: 600,
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      // Icon and name
      expect(allFgText).toContain("⏳");
      expect(allFgText).toContain("full-header-task");
      // Profile segment: profile-name (provider/model thinking)
      expect(allFgText).toContain("researcher");
      expect(allFgText).toContain("anthropic/claude-sonnet-4-20250514");
      expect(allFgText).toContain("high");
      // Tool count
      expect(allFgText).toContain("7 tools");
      // Todo segment: [completed/total]
      expect(allFgText).toContain("2/5");
      // Time segment: elapsed/timeout
      expect(allFgText).toContain("45s/600s");
    });

    it("renders header with minimal fields (no profile, no provider, no model)", () => {
      const fixedStart = Date.now() - 10_000; // 10 seconds ago
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "minimal-task",
            status: "running",
            startedAt: fixedStart,
            timeout: 300,
            toolCount: 0,
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      // Icon and name should be present
      expect(allFgText).toContain("⏳");
      expect(allFgText).toContain("minimal-task");
      // Tool count should still be present
      expect(allFgText).toContain("0 tools");
      // Time segment
      expect(allFgText).toContain("10s/300s");
      // No profile name or provider/model parenthetical should appear
      // Note: (starting...) may still appear from the empty-lines placeholder
      const dimCalls = fgCalls.filter((c: [string, string]) => c[0] === "dim");
      const dimText = dimCalls.map((c: [string, string]) => c[1]).join(" ");
      // The dim header parts should NOT contain a profile parenthetical like "name (provider/model)"
      expect(dimText).not.toMatch(/\w+ \([\w/]+\)/);
    });

    it("hides todo segment when todoTotal is undefined", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "no-todo-task",
            status: "running",
            todoTotal: undefined,
            todoCompleted: undefined,
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      // Should not contain any todo-style bracket pattern
      expect(allFgText).not.toMatch(/\d+\/\d+/);
    });

    it("hides todo segment when todoTotal is 0", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "zero-todo-task",
            status: "running",
            todoTotal: 0,
            todoCompleted: 0,
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      // Should not contain todo bracket pattern when total is 0
      expect(allFgText).not.toMatch(/\[\d+\/\d+\]/);
    });

    it("hides todo segment when all todos are complete", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "all-done-task",
            status: "running",
            todoTotal: 5,
            todoCompleted: 5,
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      // When all complete (todoCompleted === todoTotal), todo segment should be hidden
      expect(allFgText).not.toContain("0/5");
    });

    it("shows todo segment when active and incomplete", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "active-todo-task",
            status: "running",
            todoTotal: 8,
            todoCompleted: 3,
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      // Should show [completed/total] = [3/8]
      expect(allFgText).toContain("3/8");
    });

    it("does not include (N-line window) in global header", () => {
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "window-label-task",
            status: "running",
          }),
        ],
        maxLinesPerWindow: 15,
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        theme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(theme.fg).mock.calls;
      const allFgText = fgCalls.map((c: [string, string]) => c[1]).join(" ");

      // The old (N-line window) label should NOT appear anywhere
      expect(allFgText).not.toContain("-line window");
      expect(allFgText).not.toContain("15-line window");
    });

    // ── colorizeToolLine tests ────────────────────────────────────

    /** Create a theme that wraps text in [color]...[/color] markers for assertion */
    function makeMarkerTheme(): Theme {
      return {
        fg: vi.fn((color: string, text: string) => `[${color}]${text}[/${color}]`),
        bold: vi.fn((text: string) => text),
      } as unknown as Theme;
    }

    it("colorizes edit tool line with +N/-M diff stats", () => {
      const markerTheme = makeMarkerTheme();
      const toolLine = "edit → src/file.ts (3 edits) +15/-8";
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "test-task",
            status: "running",
            lines: [{ text: toolLine, kind: "tool" }],
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        markerTheme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(markerTheme.fg).mock.calls;

      // +15 should get toolDiffAdded color
      expect(fgCalls).toContainEqual(["toolDiffAdded", "+15"]);
      // The slash separator gets muted color
      expect(fgCalls).toContainEqual(["muted", "/"]);
      // The removed stat should be "-8" (without the "/" prefix)
      expect(fgCalls).toContainEqual(["toolDiffRemoved", "-8"]);
    });

    it("colorizes write tool line with +N at end", () => {
      const markerTheme = makeMarkerTheme();
      const toolLine = "write → src/file.ts +42";
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "test-task",
            status: "running",
            lines: [{ text: toolLine, kind: "tool" }],
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        markerTheme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(markerTheme.fg).mock.calls;

      // +42 should get toolDiffAdded color
      expect(fgCalls).toContainEqual(["toolDiffAdded", "+42"]);
      // The prefix should get muted color
      expect(fgCalls).toContainEqual(["muted", "write → src/file.ts "]);
    });

    it("colorizes read tool line with (N lines) pattern", () => {
      const markerTheme = makeMarkerTheme();
      const toolLine = "read → src/file.ts:10+50 (50 lines)";
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "test-task",
            status: "running",
            lines: [{ text: toolLine, kind: "tool" }],
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        markerTheme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(markerTheme.fg).mock.calls;

      // The number 50 (line count) should get toolDiffAdded color
      expect(fgCalls).toContainEqual(["toolDiffAdded", "50"]);
      // The prefix should get muted color
      expect(fgCalls).toContainEqual(["muted", "read → src/file.ts:10+50 "]);
      // Opening paren should get muted
      expect(fgCalls).toContainEqual(["muted", "("]);
      // The suffix " lines)" should get muted
      expect(fgCalls).toContainEqual(["muted", " lines)"]);
    });

    it("colorizes default tool line entirely in muted", () => {
      const markerTheme = makeMarkerTheme();
      const toolLine = "bash → npm test";
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "test-task",
            status: "running",
            lines: [{ text: toolLine, kind: "tool" }],
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        markerTheme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(markerTheme.fg).mock.calls;

      // The entire line should be in a single muted call
      expect(fgCalls).toContainEqual(["muted", "bash → npm test"]);
      // Should NOT use diff colors
      const colorNames = fgCalls.map((c: [string, string]) => c[0]);
      expect(colorNames).not.toContain("toolDiffAdded");
      expect(colorNames).not.toContain("toolDiffRemoved");
    });

    it("colorizes grep tool line entirely in muted", () => {
      const markerTheme = makeMarkerTheme();
      const toolLine = "grep → /TODO/ → *.ts";
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "test-task",
            status: "running",
            lines: [{ text: toolLine, kind: "tool" }],
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        markerTheme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(markerTheme.fg).mock.calls;

      // The entire line should be in a single muted call
      expect(fgCalls).toContainEqual(["muted", "grep → /TODO/ → *.ts"]);
      // Should NOT use diff colors
      const colorNames = fgCalls.map((c: [string, string]) => c[0]);
      expect(colorNames).not.toContain("toolDiffAdded");
      expect(colorNames).not.toContain("toolDiffRemoved");
    });

    it("does not colorize fetch_content line ending with +N (false-positive bug fix)", () => {
      const markerTheme = makeMarkerTheme();
      const toolLine = "fetch_content → https://site.com/api+1";
      const details = makeDetails({
        windows: [
          makeWindow({
            name: "test-task",
            status: "running",
            lines: [{ text: toolLine, kind: "tool" }],
          }),
        ],
        globalStatus: "running",
        sessionIds: ["session-abc123"],
      });

      renderResult(
        { content: [{ type: "text", text: "..." }], details },
        { isPartial: false, expanded: false },
        markerTheme,
        null as unknown as any,
      );

      const fgCalls = vi.mocked(markerTheme.fg).mock.calls;

      // The entire line should be in a single muted call
      expect(fgCalls).toContainEqual(["muted", "fetch_content → https://site.com/api+1"]);
      // Should NOT use diff colors (this is the bug fix - +N in URL should not be colorized)
      const colorNames = fgCalls.map((c: [string, string]) => c[0]);
      expect(colorNames).not.toContain("toolDiffAdded");
      expect(colorNames).not.toContain("toolDiffRemoved");
    });
  });
});
