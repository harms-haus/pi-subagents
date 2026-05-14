import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubAgent } from "../spawner";
import type { SubAgentWindow, SubagentSessionData } from "../types";

// Mock pi-coding-agent (used by profiles.ts for parseFrontmatter)
vi.mock("@earendil-works/pi-coding-agent", () => ({
  parseFrontmatter: vi.fn((content: string) => {
    const lines = content.split("\n");
    return { frontmatter: {}, body: lines.slice(2).join("\n") };
  }),
}));

// Mock profiles module — keep real implementations but override loadCommandPreviewWidth
// so tests are deterministic regardless of terminal width
vi.mock("../profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../profiles")>();
  return {
    ...actual,
    loadCommandPreviewWidth: vi.fn().mockResolvedValue(160),
  };
});

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { loadCommandPreviewWidth } from "../profiles";

// Create a mock ChildProcess
type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn((signal: string) => {
    proc.killed = true;
    proc.emit("exit", signal === "SIGTERM" ? 0 : 1);
  });
  return proc;
}

describe("spawner", () => {
  let mockProcess: ReturnType<typeof createMockProcess>;
  let mockWindow: SubAgentWindow;
  let mockSession: SubagentSessionData;
  let onUpdateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess);

    mockWindow = {
      name: "test-task",
      sessionId: "test-session-id",
      status: "running",
      lines: [],
      allMessages: [],
      exitCode: null,
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

    onUpdateSpy = vi.fn();
  });

  describe("runSubAgent", () => {
    it("should spawn with correct arguments", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(spawn).toHaveBeenCalled();
      const spawnArgs = vi.mocked(spawn).mock.calls[0];
      // getPiInvocation() returns the actual node path and script path
      expect(spawnArgs[0]).toBeTruthy();
      expect(spawnArgs[1]).toContain("--mode");
      expect(spawnArgs[1]).toContain("json");
      expect(spawnArgs[1]).toContain("-p");
      expect(spawnArgs[1]).toContain("--no-session");
      expect(spawnArgs[1]).toContain("test prompt");

      // Clean up
      mockProcess.emit("close", 0);
      await promise;
    });

    it("should use absolute path when cwd is absolute", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: "/absolute/path" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(spawn).toHaveBeenCalled();
      // validateCwd will resolve the path, but we test that it was called
      expect(spawn).toHaveBeenCalled();
      const spawnOptions = vi.mocked(spawn).mock.calls[0][2];
      expect(spawnOptions.cwd).toBeTruthy();

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should normalize paths and check for '..' after resolution", async () => {
      // resolve() normalizes paths like /safe/../unsafe to /unsafe
      // The '..' check happens AFTER resolve(), so normalized paths pass
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: "/safe/../unsafe" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(spawn).toHaveBeenCalled();
      const spawnOptions = vi.mocked(spawn).mock.calls[0][2];
      // The path is normalized to /unsafe by resolve()
      expect(spawnOptions.cwd).toBe("/unsafe");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should resolve relative paths using current directory", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: "relative/path" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // spawn should be called because resolve() makes relative paths absolute
      // validateCwd will resolve the relative path to absolute
      expect(spawn).toHaveBeenCalled();
      const spawnOptions = vi.mocked(spawn).mock.calls[0][2];
      expect(spawnOptions.cwd).toBeTruthy();

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should handle process stdout lines", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate stdout data
      mockProcess.stdout.emit("data", Buffer.from("line 1\nline 2\n"));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockWindow.lines).toHaveLength(2);
      expect(mockWindow.lines[0].text).toBe("line 1");
      expect(mockWindow.lines[1].text).toBe("line 2");

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

      await new Promise((resolve) => setTimeout(resolve, 10));

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

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockSession.messages).toHaveLength(1);
      expect(mockSession.messages[0].role).toBe("assistant");
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

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate malformed JSON (should be treated as plain text)
      mockProcess.stdout.emit("data", Buffer.from("{ invalid json }\n"));

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should treat as plain text, not as JSON
      expect(mockWindow.lines[0].text).toContain("invalid");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should handle process exit with code 0", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockProcess.emit("close", 0);
      await promise;

      expect(mockWindow.exitCode).toBe(0);
      expect(mockWindow.status).toBe("completed");
    });

    it("should handle process exit with non-zero code", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockProcess.emit("close", 1);
      await promise;

      expect(mockWindow.exitCode).toBe(1);
      expect(mockWindow.status).toBe("error");
    });

    it("should handle abort signal with SIGTERM", async () => {
      const abortController = new AbortController();

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        signal: abortController.signal,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Abort the process
      abortController.abort();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should handle abort signal that is already aborted", async () => {
      const abortController = new AbortController();
      abortController.abort(); // Already aborted

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        signal: abortController.signal,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should include profile args when profile is provided", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        profile: {
          provider: "openai",
          model: "gpt-4",
          systemPrompt: "test system",
          thinkingLevel: "high",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(spawn).toHaveBeenCalled();
      const spawnArgs = vi.mocked(spawn).mock.calls[0][1];

      // Profile should inject additional args and env vars
      expect(spawnArgs).toContain("test prompt");

      const spawnOptions = vi.mocked(spawn).mock.calls[0][2];
      expect(spawnOptions.env).toBeDefined();

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("path shortening in tool call display", () => {
    const CWD = "/home/user/projects/my-app";

    async function emitToolCall(toolName: string, args: Record<string, unknown>): Promise<void> {
      const jsonEvent = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: toolName, arguments: args }],
        },
      });

      mockProcess.stdout.emit("data", Buffer.from(`${jsonEvent}\n`));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    function findToolLine(keyword: string) {
      const line = mockWindow.lines.find((l) => l.text.includes(keyword));
      if (!line) {
        throw new Error(
          `Expected to find a line containing "${keyword}" in: ${mockWindow.lines.map((l) => l.text).join(", ")}`,
        );
      }
      return line;
    }

    it("should shorten bash command paths relative to cwd", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("bash", { command: "cat /home/user/projects/my-app/src/index.ts" });

      const toolLine = findToolLine("bash");
      // The path appears in the output (shortenPathsInText extracts paths without leading /)
      expect(toolLine.text).toContain("src/index.ts");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should strip cd <cwd> && prefix from bash commands", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("bash", { command: "cd /home/user/projects/my-app && npm test" });

      const toolLine = findToolLine("bash");
      expect(toolLine.text).toBe("→ bash → npm test");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should shorten edit tool file path", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("edit", {
        path: "/home/user/projects/my-app/src/utils.ts",
        edits: [{ oldText: "x", newText: "y" }],
      });

      const toolLine = findToolLine("edit");
      expect(toolLine.text).toBe("→ edit → src/utils.ts (1 edit)");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should shorten read tool file path", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("read", {
        path: "/home/user/projects/my-app/src/index.ts",
        offset: 10,
        limit: 20,
      });

      const toolLine = findToolLine("read");
      expect(toolLine.text).toBe("→ read → src/index.ts:10+20");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should shorten write tool file path", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("write", {
        path: "/home/user/projects/my-app/src/new-file.ts",
        content: "hello",
      });

      const toolLine = findToolLine("write");
      expect(toolLine.text).toBe("→ write → src/new-file.ts");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should shorten lsp-diagnostics file path", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("lsp-diagnostics", {
        file: "/home/user/projects/my-app/src/app.tsx",
      });

      const toolLine = findToolLine("lsp-diagnostics");
      expect(toolLine.text).toBe("→ lsp-diagnostics → src/app.tsx");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should shorten lint-files paths", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("lint-files", {
        files: ["/home/user/projects/my-app/src/a.ts", "/home/user/projects/my-app/src/b.ts"],
      });

      const toolLine = findToolLine("lint");
      expect(toolLine.text).toBe("→ lint → src/a.ts, src/b.ts");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should keep unrelated absolute paths unchanged", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("read", {
        path: "/usr/local/share/some/config.json",
      });

      const toolLine = findToolLine("read");
      // The path should remain absolute since making it relative would be longer
      expect(toolLine.text).toContain("/usr/local/share/some/config.json");

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("smart && splitting in bash command display", () => {
    const CWD = "/home/user/projects/my-app";

    async function emitToolCall(toolName: string, args: Record<string, unknown>): Promise<void> {
      const jsonEvent = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: toolName, arguments: args }],
        },
      });

      mockProcess.stdout.emit("data", Buffer.from(`${jsonEvent}\n`));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    function findToolLines(keyword: string) {
      return mockWindow.lines.filter((l) => l.text.includes(keyword));
    }

    it("should split bash command with && across lines when segments overflow a narrow width", async () => {
      // Set a narrow width budget so that the command must wrap
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(40);

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Command is: npm run build && npm run test && npm run lint
      // With width 40, the prefix accounts for 12 chars (indent, arrow, "bash → "),
      // so firstLineBudget passed to formatBashCommand is 40 - 12 = 28
      // contBudget is 40 - 5 = 35
      // "npm run build && npm run test" = 30 chars, over firstLineBudget (28)
      // "npm run build &&" = 16 chars, fits → flush, then new line
      // "npm run test &&" = 15 chars, fits in contBudget (35)
      // Then "npm run lint" = 13 chars, fits in contBudget (35)
      await emitToolCall("bash", {
        command: "npm run build && npm run test && npm run lint",
      });

      const bashLines = findToolLines("bash");
      // The multi-line output is stored as a single entry with embedded \n
      expect(bashLines.length).toBe(1);
      const text = bashLines[0].text;

      // Should contain a newline (the && split point)
      expect(text).toContain("\n");
      // First part should contain the initial segments ending with &&
      expect(text).toContain("npm run build && npm run test &&");
      // Second part (after newline) should have the remaining segment
      expect(text).toContain("npm run lint");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should truncate a single overlong segment with ellipsis when no && split points exist", async () => {
      // Set a very narrow width so a long single command truncates
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(30);

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Single command with no && — width 30, prefix takes 7, so 23 chars for content
      await emitToolCall("bash", {
        command: "echo 'this is a really really really long command that should be truncated'",
      });

      const toolLine = mockWindow.lines.find((l) => l.text.includes("bash"));
      expect(toolLine).toBeTruthy();
      // The line should contain "..." indicating truncation
      expect(toolLine?.text).toContain("...");
      // And the full long command should NOT appear verbatim
      expect(toolLine?.text).not.toContain("should be truncated");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should truncate an overlong segment in the middle of a && chain", async () => {
      // Set a narrow width so the middle segment overflows
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(40);

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // "short" fits, but "this-is-a-very-long-middle-segment-that-will-overflow" does not
      await emitToolCall("bash", {
        command: "short && this-is-a-very-long-middle-segment-that-will-overflow && tail",
      });

      const bashLines = findToolLines("bash");
      // The long segment should be truncated with "..."
      const allText = bashLines.map((l) => l.text).join("\n");
      expect(allText).toContain("...");
      // "tail" segment should still appear somewhere
      expect(allText).toContain("tail");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should not split when the full command fits within width budget", async () => {
      // Generous width — command should appear on a single line
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(160);

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("bash", {
        command: "npm test && npm run lint",
      });

      const bashLines = findToolLines("bash");
      // Should fit on a single line
      expect(bashLines.length).toBe(1);
      expect(bashLines[0].text).toBe("→ bash → npm test && npm run lint");

      mockProcess.emit("close", 0);
      await promise;
    });
  });
});
