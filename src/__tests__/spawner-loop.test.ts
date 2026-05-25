import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubAgent } from "../spawner";
import type { SubAgentWindow, SubagentSessionData } from "../types";
import type * as ProfilesModule from "../profiles";
import { createMockProcess, emitToolCall, waitForCondition } from "./helpers";

// Mock pi-coding-agent (used by profiles.ts for parseFrontmatter)
vi.mock("@earendil-works/pi-coding-agent", () => ({
  parseFrontmatter: vi.fn((content: string) => {
    const lines = content.split("\n");
    return { frontmatter: {}, body: lines.slice(2).join("\n") };
  }),
}));

// Mock profiles module
vi.mock("../profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof ProfilesModule>();
  return { ...actual };
});

// Mock settings module
vi.mock("../settings", () => ({
  loadCommandPreviewWidth: vi.fn().mockResolvedValue(160),
  loadExtendTimeoutDebounce: vi.fn().mockResolvedValue(30),
  loadLoopingToolCount: vi.fn().mockResolvedValue(5),
}));

// Mock node:fs (used by profiles.ts)
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock node:fs/promises (used by profiles.ts)
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

describe("spawner-loop", () => {
  let mockProcess: ReturnType<typeof createMockProcess>;
  let mockWindow: SubAgentWindow;
  let mockSession: SubagentSessionData;
  let onUpdateSpy: () => void;

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

  describe("loop detection", () => {
    const CWD = "/home/user/projects/my-app";

    it("should not detect loop when tool calls are different", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", { command: "cmd1" });
      emitToolCall(mockProcess, "read", { path: "/a" });
      emitToolCall(mockProcess, "bash", { command: "cmd2" });
      emitToolCall(mockProcess, "write", { path: "/b", content: "x" });
      emitToolCall(mockProcess, "grep", { pattern: "test" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(false);
    });

    it("should detect loop with identical consecutive tool calls", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "read", { path: "/same/file.ts" });
      emitToolCall(mockProcess, "read", { path: "/same/file.ts" });
      emitToolCall(mockProcess, "read", { path: "/same/file.ts" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
      expect(mockWindow.recentToolCalls?.length).toBe(3);
    });

    it("should detect loop with identical tool calls", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", { command: "cat /src/index.ts" });
      emitToolCall(mockProcess, "bash", { command: "cat /src/index.ts" });
      emitToolCall(mockProcess, "bash", { command: "cat /src/index.ts" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
    });

    it("should not detect loop when tool calls differ", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", { command: "npm run build" });
      emitToolCall(mockProcess, "bash", { command: "npm run test" });
      emitToolCall(mockProcess, "bash", { command: "npm run lint" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(false);
    });

    it("should use default loopingToolCount of 5 when not specified — 4 calls no loop", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "read", { path: "/a" });
      emitToolCall(mockProcess, "read", { path: "/a" });
      emitToolCall(mockProcess, "read", { path: "/a" });
      emitToolCall(mockProcess, "read", { path: "/a" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(false);
    });

    it("should use default loopingToolCount of 5 when not specified — 5 calls triggers loop", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "read", { path: "/a" });
      emitToolCall(mockProcess, "read", { path: "/a" });
      emitToolCall(mockProcess, "read", { path: "/a" });
      emitToolCall(mockProcess, "read", { path: "/a" });
      emitToolCall(mockProcess, "read", { path: "/a" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
    });

    it("should not detect loop when count threshold is 0", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 0,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "read", { path: "/same" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(false);
    });

    it("should only check the last N tool calls", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", { command: "a" });
      emitToolCall(mockProcess, "bash", { command: "b" });
      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "read", { path: "/same" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
    });

    it("should detect loop mid-stream and still resolve correctly", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "read", { path: "/same" });
      emitToolCall(mockProcess, "bash", { command: "echo done" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
    });

    it("should not detect loop when no tool calls are emitted", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      const jsonEvent = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Just text output" }] },
      });
      mockProcess.stdout.emit("data", Buffer.from(`${jsonEvent}\n`));

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(false);
    });

    it("should detect loop with multiple tool calls in one message", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      const jsonEvent = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read", arguments: { path: "/same" } },
            { type: "toolCall", name: "read", arguments: { path: "/same" } },
            { type: "toolCall", name: "read", arguments: { path: "/same" } },
          ],
        },
      });
      mockProcess.stdout.emit("data", Buffer.from(`${jsonEvent}\n`));

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
    });

    it("should kill the process when loop is detected", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "read", { path: "/same/file.ts" });
      emitToolCall(mockProcess, "read", { path: "/same/file.ts" });
      emitToolCall(mockProcess, "read", { path: "/same/file.ts" });

      expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
    });
  });
});
