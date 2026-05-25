import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubAgent } from "../spawner";
import type { SubAgentWindow, SubagentSessionData } from "../types";
import { createMockProcess, emitToolCall, waitForCondition, waitForCalls } from "./helpers";

// Mock settings module — override loadCommandPreviewWidth
vi.mock("../settings", () => ({
  loadCommandPreviewWidth: vi.fn().mockResolvedValue(160),
  loadExtendTimeoutDebounce: vi.fn().mockResolvedValue(30),
  loadLoopingToolCount: vi.fn().mockResolvedValue(5),
}));

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock profiles module (needed by spawner)
vi.mock("../profiles", () => ({
  profileToArgs: vi.fn(() => ({ args: [], env: {} })),
}));

import { spawn } from "node:child_process";

describe("spawner-output", () => {
  let mockProcess: ReturnType<typeof createMockProcess>;
  let mockWindow: SubAgentWindow;
  let mockSession: SubagentSessionData;
  let onUpdateSpy: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ChildProcess);

    mockWindow = {
      name: "test-task",
      sessionId: "test-session-id",
      status: "running",
      lines: [],
      allMessages: [],
      exitCode: null,
      startedAt: Date.now(),
      timeout: 600,
      toolCount: 0,
      fileCount: 0,
    };

    mockSession = {
      sessionId: "test-session-id",
      taskName: "test-task",
      prompt: "test prompt",
      cwd: "/tmp",
      status: "running",
      messages: [],
      exitCode: null,
      startedAt: Date.now(),
    };

    onUpdateSpy = vi.fn<() => void>();
  });

  describe("runSubAgent output processing", () => {
    it("should handle process stdout lines", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Simulate stdout data
      mockProcess.stdout.emit("data", Buffer.from("line 1\nline 2\n"));

      // stdout line processing is synchronous — window lines should be populated immediately
      expect(mockWindow.lines).toHaveLength(2);
      expect(mockWindow.lines[0]!.text).toBe("line 1");
      expect(mockWindow.lines[1]!.text).toBe("line 2");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should process JSON message_end events", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Simulate JSON message_end event
      const jsonEvent = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "assistant response" }],
          model: "test-model",
        },
      });

      mockProcess.stdout.emit("data", Buffer.from(`${jsonEvent}\n`));

      // JSON event processing is synchronous
      expect(mockSession.messages).toHaveLength(1);
      expect(mockSession.messages[0]!.role).toBe("assistant");
      expect(mockWindow.model).toBe("test-model");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should handle malformed JSON gracefully", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Simulate malformed JSON (should be treated as plain text)
      mockProcess.stdout.emit("data", Buffer.from("{ invalid json }\n"));

      // Should treat as plain text, not as JSON
      expect(mockWindow.lines[0]!.text).toContain("invalid");

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("MAX_MESSAGES_PER_SESSION eviction", () => {
    const CWD = "/home/user/projects/my-app";
    const MAX_MESSAGES = 500;

    it("should cap session.messages at MAX_MESSAGES_PER_SESSION and evict oldest", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 10000,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit MAX_MESSAGES + 50 message_end events (550 total)
      const totalMessages = MAX_MESSAGES + 50;
      const chunks: string[] = [];
      for (let i = 0; i < totalMessages; i++) {
        chunks.push(
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: `msg-${i}` }],
              model: "test-model",
            },
          }),
        );
      }
      // Send all at once as a single data event with newline separators
      mockProcess.stdout.emit("data", Buffer.from(`${chunks.join("\n")}\n`));

      // Processing is synchronous for all lines in one data event
      // session.messages should be capped at MAX_MESSAGES_PER_SESSION
      // The eviction logic: push then if >= MAX, shift. Steady state is MAX-1.
      expect(mockSession.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
      expect(mockSession.messages.length).toBe(MAX_MESSAGES - 1);

      // The oldest messages should have been evicted — the first message
      // should be msg-51 (index 51), not msg-0
      // 550 messages emitted, 499 retained, so first retained is index 51
      const firstRetainedIndex = totalMessages - (MAX_MESSAGES - 1);
      const firstMsgContent = (
        mockSession.messages[0]!.content as Array<{ type: string; text: string }>
      )[0]!.text;
      expect(firstMsgContent).toBe(`msg-${firstRetainedIndex}`);

      // The last message should be the most recent
      const lastMsgContent = (
        mockSession.messages[mockSession.messages.length - 1]!.content as Array<{
          type: string;
          text: string;
        }>
      )[0]!.text;
      expect(lastMsgContent).toBe(`msg-${totalMessages - 1}`);

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("turn_end ls/find result handling", () => {
    const CWD = "/home/user/projects/my-app";

    async function emitTurnEnd(
      toolResults: Array<{
        toolName: string;
        content: Array<{ type: string; text?: string }>;
        details?: Record<string, unknown>;
        isError: boolean;
      }>,
    ): Promise<void> {
      const jsonEvent = JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: [] },
        toolResults,
      });
      mockProcess.stdout.emit("data", Buffer.from(`${jsonEvent}\n`));
    }

    it("should append inline ls summary to existing ls tool call line", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // First emit the tool call (message_end with toolCall)
      emitToolCall(mockProcess, "ls", { path: "." });
      // Then emit the turn_end with the result
      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "file1.ts\nfile2.ts\ndir1/" }],
          isError: false,
        },
      ]);

      // The ls tool line should now have the inline summary appended
      const lsLine = mockWindow.lines.find((l) => l.kind === "tool" && l.text.includes("ls →"));
      expect(lsLine?.text).toBe("→ ls → . → 2 files, 1 dir");
      expect(lsLine?.kind).toBe("tool");

      // No separate summary line should have been added
      const summaryLines = mockWindow.lines.filter(
        (l) => l.kind === "tool" && l.text === "  2 files, 1 dir",
      );
      expect(summaryLines).toHaveLength(0);

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should append inline find summary to existing find tool call line", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "find", { pattern: "*.ts" });
      await emitTurnEnd([
        {
          toolName: "find",
          content: [{ type: "text", text: "result1.ts\nresult2.ts\nresult3.ts" }],
          isError: false,
        },
      ]);

      const findLine = mockWindow.lines.find((l) => l.kind === "tool" && l.text.includes("find →"));
      expect(findLine?.text).toBe("→ find → *.ts → 3 matches");
      expect(findLine?.kind).toBe("tool");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should ignore non-ls/find tools", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      const linesBefore = mockWindow.lines.length;

      await emitTurnEnd([
        {
          toolName: "read",
          content: [{ type: "text", text: "file contents here" }],
          isError: false,
        },
      ]);

      expect(mockWindow.lines.length).toBe(linesBefore);

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should ignore error results", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      const linesBefore = mockWindow.lines.length;

      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "file1.ts\nfile2.ts" }],
          isError: true,
        },
      ]);

      expect(mockWindow.lines.length).toBe(linesBefore);

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should handle multiple tool results matching multiple tool lines", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit two tool calls
      emitToolCall(mockProcess, "ls", { path: "." });
      emitToolCall(mockProcess, "find", { pattern: "*.ts" });

      // Emit turn_end with both results
      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
          isError: false,
        },
        {
          toolName: "find",
          content: [{ type: "text", text: "match1.ts\nmatch2.ts" }],
          isError: false,
        },
      ]);

      // Both tool lines should have inline summaries appended
      const lsLine = mockWindow.lines.find((l) => l.kind === "tool" && l.text.includes("ls →"));
      const findLine = mockWindow.lines.find((l) => l.kind === "tool" && l.text.includes("find →"));

      expect(lsLine?.text).toBe("→ ls → . → 3 files");
      expect(findLine?.text).toBe("→ find → *.ts → 2 matches");

      // No separate summary lines
      const summaryLines = mockWindow.lines.filter(
        (l) => l.kind === "tool" && l.text.startsWith("  "),
      );
      expect(summaryLines).toHaveLength(0);

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should append separate inline summaries for two ls calls in same turn", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit two ls tool calls with different paths
      emitToolCall(mockProcess, "ls", { path: "src" });
      emitToolCall(mockProcess, "ls", { path: "test" });

      // Emit turn_end with two ls results
      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "a.ts\nb.ts" }],
          isError: false,
        },
        {
          toolName: "ls",
          content: [{ type: "text", text: "spec1.ts\nspec2.ts\nspec3.ts" }],
          isError: false,
        },
      ]);

      // Each ls tool line should have its own inline summary
      const lsLines = mockWindow.lines.filter((l) => l.kind === "tool" && l.text.includes("ls →"));
      expect(lsLines).toHaveLength(2);
      expect(lsLines[0]!.text).toBe("→ ls → src → 2 files");
      expect(lsLines[1]!.text).toBe("→ ls → test → 3 files");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should fall back to separate line when no matching tool line exists", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit turn_end WITHOUT a prior tool call
      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "file1.ts\nfile2.ts" }],
          isError: false,
        },
      ]);

      // Should fall back to appending a separate line with tool name
      const summaryLine = mockWindow.lines.find(
        (l) => l.kind === "tool" && l.text.includes("files"),
      );
      expect(summaryLine?.text).toBe("  ls: 2 files");
      expect(summaryLine?.kind).toBe("tool");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should also update win.allMessages when appending inline summary", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "ls", { path: "src" });
      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "a.ts\nb.ts" }],
          isError: false,
        },
      ]);

      const lsAllMsg = mockWindow.allMessages.find(
        (l) => l.kind === "tool" && l.text.includes("ls →"),
      );
      expect(lsAllMsg?.text).toBe("→ ls → src → 2 files");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should not misattribute result to already-inlined line from previous turn", async () => {
      // Regression test for cross-turn misattribution bug:
      // Turn A: tool call `→ ls → src/` → result inlines to `→ ls → src/ → 2 files, 1 dir`
      // Turn B: tool call `→ ls → tests/` → result scan should NOT match Turn A's inlined line
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // --- Turn A ---
      emitToolCall(mockProcess, "ls", { path: "src" });
      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "a.ts\nb.ts\ndir1/" }],
          isError: false,
        },
      ]);

      // Verify Turn A result is inlined correctly
      const turnALine = mockWindow.lines.find((l) => l.kind === "tool" && l.text.includes("ls →"));
      expect(turnALine?.text).toBe("→ ls → src → 2 files, 1 dir");

      // --- Turn B ---
      emitToolCall(mockProcess, "ls", { path: "tests" });
      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "spec1.ts\nspec2.ts\nspec3.ts" }],
          isError: false,
        },
      ]);

      // Turn A's line should NOT have been modified by Turn B's result
      const lsLines = mockWindow.lines.filter((l) => l.kind === "tool" && l.text.includes("ls →"));
      expect(lsLines).toHaveLength(2);
      expect(lsLines[0]!.text).toBe("→ ls → src → 2 files, 1 dir");
      expect(lsLines[1]!.text).toBe("→ ls → tests → 3 files");

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("handleStderrData", () => {
    it("should process stderr buffer and display with [stderr] prefix", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit stderr data
      mockProcess.stderr.emit("data", Buffer.from("Warning: deprecated API usage\n"));

      // Wait for the debounced onUpdate (50ms debounce)
      await waitForCalls(onUpdateSpy, 1);

      // Should appear in window lines with [stderr] prefix
      const stderrLine = mockWindow.lines.find((l) => l.text.includes("[stderr]"));
      expect(stderrLine).toBeTruthy();
      expect(stderrLine?.text).toContain("[stderr]: Warning: deprecated API usage");

      // onUpdate should have been called
      expect(onUpdateSpy).toHaveBeenCalled();

      mockProcess.emit("close", 0);
      await promise;
    });
  });
});
