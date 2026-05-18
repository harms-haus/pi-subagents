import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubAgent } from "../spawner";
import type { SubAgentWindow, SubagentSessionData } from "../types";
import type * as ProfilesModule from "../profiles";
import { createMockProcess } from "./helpers";

// Mock pi-coding-agent (used by profiles.ts for parseFrontmatter)
vi.mock("@earendil-works/pi-coding-agent", () => ({
  parseFrontmatter: vi.fn((content: string) => {
    const lines = content.split("\n");
    return { frontmatter: {}, body: lines.slice(2).join("\n") };
  }),
}));

// Mock profiles module — keep real implementations
vi.mock("../profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof ProfilesModule>();
  return {
    ...actual,
  };
});

// Mock settings module — override loadCommandPreviewWidth
// so tests are deterministic regardless of terminal width
vi.mock("../settings", () => ({
  loadCommandPreviewWidth: vi.fn().mockResolvedValue(160),
  loadExtendTimeoutDebounce: vi.fn().mockResolvedValue(30),
  loadLoopingToolCount: vi.fn().mockResolvedValue(5),
  loadLoopingToolSimilarity: vi.fn().mockResolvedValue(0.95),
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

import { existsSync, mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { deleteProfile, invalidateProfilesCache, saveProfile } from "../profiles";
import { loadCommandPreviewWidth } from "../settings";

describe("spawner", () => {
  let mockProcess: ReturnType<typeof createMockProcess>;
  let mockWindow: SubAgentWindow;
  let mockSession: SubagentSessionData;
  let onUpdateSpy: ReturnType<typeof vi.fn>;

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
      expect(spawnArgs[0]).toEqual(expect.any(String));
      expect(spawnArgs[0].length).toBeGreaterThan(0);
      expect(spawnArgs[1]).toContain("--mode");
      expect(spawnArgs[1]).toContain("json");
      expect(spawnArgs[1]).toContain("-p");
      expect(spawnArgs[1]).toContain("--no-session");
      expect(spawnArgs[1]).not.toContain("test prompt");

      // Prompt should be written to stdin via end(), not passed as CLI arg
      expect(mockProcess.stdin.end).toHaveBeenCalledWith(expect.stringContaining("test prompt"));
      expect(mockProcess.stdin.write).not.toHaveBeenCalled();

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
      const spawnOptions = vi.mocked(spawn).mock.calls[0][2];
      expect(spawnOptions.cwd).toBe("/absolute/path");

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
      expect(spawnOptions.cwd).toMatch(/^\//);
      expect((spawnOptions.cwd as string).endsWith("/relative/path")).toBe(true);

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

    it("should escalate from SIGTERM to SIGKILL after 5s if process does not die", async () => {
      vi.useFakeTimers();

      // Create a process where SIGTERM does NOT set killed=true
      // (simulating an unresponsive process that ignores SIGTERM)
      const escalationProc = createMockProcess();
      escalationProc.kill = vi.fn((signal: string) => {
        if (signal === "SIGKILL") {
          escalationProc.killed = true;
          escalationProc.emit("exit", 1);
        }
        // SIGTERM: do nothing — process stays alive
      });
      vi.mocked(spawn).mockReturnValue(escalationProc as unknown as ChildProcess);

      const abortController = new AbortController();

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        signal: abortController.signal,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      // Let async setup complete (loadCommandPreviewWidth is awaited)
      await vi.advanceTimersByTimeAsync(100);

      // Abort triggers SIGTERM
      abortController.abort();
      expect(escalationProc.kill).toHaveBeenCalledWith("SIGTERM");
      expect(escalationProc.killed).toBe(false);

      // Advance past the 5-second escalation timeout
      await vi.advanceTimersByTimeAsync(6000);

      // SIGKILL should now have been sent
      expect(escalationProc.kill).toHaveBeenCalledWith("SIGKILL");
      expect(escalationProc.killed).toBe(true);

      // Resolve the main promise
      escalationProc.emit("close", 1);
      await promise;

      vi.useRealTimers();
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

    it("should handle proc 'error' event (spawn failure)", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit 'error' instead of 'close' to simulate spawn failure
      mockProcess.emit("error", new Error("spawn ENOENT"));
      await promise;

      expect(mockWindow.exitCode).toBe(1);
      expect(mockWindow.status).toBe("error");
      expect(mockWindow.errorMessage).toContain("Failed to spawn");
      expect(mockSession.status).toBe("error");
      expect(mockSession.exitCode).toBe(1);
    });

    it("should handle a very long prompt passed via stdin", async () => {
      const longPrompt = "x".repeat(600000); // 600KB prompt

      const promise = runSubAgent({
        task: { name: "test-task", prompt: longPrompt },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(spawn).toHaveBeenCalled();
      const spawnArgs = vi.mocked(spawn).mock.calls[0][1];

      // The prompt should NOT appear as a CLI argument
      expect(spawnArgs).not.toContain(longPrompt);

      // stdin.end should have been called with the prompt (possibly chunked)
      const endCalls = vi.mocked(mockProcess.stdin.end).mock.calls;
      const writtenData = endCalls.map((call) => String(call[0])).join("");
      expect(writtenData).toContain(longPrompt);

      // stdin.write should NOT have been called
      expect(mockProcess.stdin.write).not.toHaveBeenCalled();

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
      // Prompt is passed via stdin via end(), not as CLI arg
      expect(spawnArgs).not.toContain("test prompt");
      expect(mockProcess.stdin.end).toHaveBeenCalledWith(expect.stringContaining("test prompt"));

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
      expect(toolLine.text).toBe("→ edit → src/utils.ts (1 edit) +1/-1");

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
      expect(toolLine.text).toBe("→ read → src/index.ts:10+20 (20 lines)");

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
      expect(toolLine.text).toBe("→ write → src/new-file.ts +1");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should shorten lsp_diagnostics file path", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("lsp_diagnostics", {
        file: "/home/user/projects/my-app/src/app.tsx",
      });

      const toolLine = findToolLine("lsp_diagnostics");
      expect(toolLine.text).toBe("→ lsp_diagnostics → src/app.tsx");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should shorten lint_files paths", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("lint_files", {
        files: ["/home/user/projects/my-app/src/a.ts", "/home/user/projects/my-app/src/b.ts"],
      });

      const toolLine = findToolLine("lint");
      expect(toolLine.text).toBe("→ lint → src/a.ts, src/b.ts");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should format grep with pattern only", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("grep", { pattern: "TODO" });

      const toolLine = findToolLine("grep");
      expect(toolLine.text).toBe("→ grep → /TODO/");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should format grep with pattern and path", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("grep", {
        pattern: "TODO",
        path: "/home/user/projects/my-app/src",
      });

      const toolLine = findToolLine("grep");
      expect(toolLine.text).toBe("→ grep → /TODO/ → src");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should format grep with pattern and glob", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("grep", {
        pattern: "TODO",
        glob: "*.ts",
      });

      const toolLine = findToolLine("grep");
      expect(toolLine.text).toBe("→ grep → /TODO/ → *.ts");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should format grep with glob taking priority over path", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("grep", {
        pattern: "TODO",
        path: "/home/user/projects/my-app/src",
        glob: "*.ts",
      });

      const toolLine = findToolLine("grep");
      expect(toolLine.text).toBe("→ grep → /TODO/ → *.ts");

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

  describe("formatToolCall default case", () => {
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

    it("should render unknown tool with empty args as just toolName", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("my_tool", {});
      const toolLine = findToolLine("my_tool");
      expect(toolLine.text).toBe("\u2192 my_tool");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should render unknown tool with single arg as toolName {JSON args}", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("custom_tool", { target: "build-output" });
      const toolLine = findToolLine("custom_tool");
      expect(toolLine.text).toContain('custom_tool {"target":"build-output"}');

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should render unknown tool with multiple args as toolName {JSON args}", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("multi_arg_tool", { a: 1, b: "two", c: true });
      const toolLine = findToolLine("multi_arg_tool");
      expect(toolLine.text).toContain('multi_arg_tool {"a":1,"b":"two","c":true}');

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should truncate very long args with ellipsis", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      // Use a very narrow width to force truncation
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(30);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const longValue = "x".repeat(200);
      await emitToolCall("big_tool", { data: longValue });
      const toolLine = findToolLine("big_tool");
      expect(toolLine.text).toContain("big_tool");
      expect(toolLine.text).toContain("...");
      // Should NOT contain the full 200-char string
      expect(toolLine.text).not.toContain(longValue);

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("todo tool renderers", () => {
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

    it("should render write_todos with count", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("write_todos", {
        mode: "replace",
        todos: [{ text: "Task A" }, { text: "Task B" }],
      });
      const writeLine = findToolLine("write_todos");
      expect(writeLine.text).toContain("write_todos → 2 todos written");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should render edit_todos with action and indices when no todos array", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("edit_todos", {
        action: "complete",
        indices: [0, 2, 4],
      });
      const editLine = findToolLine("edit_todos");
      expect(editLine.text).toContain("edit_todos → complete [0,2,4]");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should render edit_todos with todo text descriptions", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("edit_todos", {
        action: "add",
        indices: [5],
        todos: [{ text: "Fix bug in auth" }, { text: "Add tests" }],
      });
      const editLine = findToolLine("edit_todos");
      expect(editLine.text).toContain("edit_todos → Fix bug in auth, Add tests");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should truncate edit_todos descriptions at 48 chars", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const longDesc =
        "This is a very long todo description that should be truncated because it exceeds 48 chars";
      await emitToolCall("edit_todos", {
        action: "add",
        indices: [0],
        todos: [{ text: longDesc }],
      });
      const editLine = findToolLine("edit_todos");
      // The description is joined and truncated to 48 chars (45 chars + "...")
      expect(editLine.text).toContain(
        "edit_todos → This is a very long todo description that sho...",
      );
      // The full description should NOT appear
      expect(editLine.text).not.toContain("exceeds 48 chars");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should render list_todos with no arguments", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("list_todos", {});
      const listLine = findToolLine("list_todos");
      expect(listLine.text).toBe("\u2192 list_todos");

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("tool count and todo tracking in handleStdoutLine", () => {
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

    it("should not modify toolCount during tool calls (set at window creation)", async () => {
      mockWindow.toolCount = 25; // Set by delegate.ts at creation time
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockWindow.toolCount).toBe(25);

      await emitToolCall("bash", { command: "echo hello" });
      expect(mockWindow.toolCount).toBe(25); // Unchanged

      await emitToolCall("read", { path: "/some/file.ts" });
      expect(mockWindow.toolCount).toBe(25); // Unchanged

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should set todoTotal and reset todoCompleted on write_todos replace", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockWindow.todoTotal).toBeUndefined();
      expect(mockWindow.todoCompleted).toBeUndefined();

      await emitToolCall("write_todos", {
        mode: "replace",
        todos: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }, { text: "E" }],
      });
      expect(mockWindow.todoTotal).toBe(5);
      expect(mockWindow.todoCompleted).toBe(0);

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should increment todoCompleted on edit_todos complete", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // First write todos
      await emitToolCall("write_todos", {
        mode: "replace",
        todos: [{ text: "A" }, { text: "B" }, { text: "C" }],
      });
      expect(mockWindow.todoTotal).toBe(3);
      expect(mockWindow.todoCompleted).toBe(0);

      // Complete indices 0 and 2
      await emitToolCall("edit_todos", {
        action: "complete",
        indices: [0, 2],
      });
      expect(mockWindow.todoCompleted).toBe(2);

      // Complete index 1
      await emitToolCall("edit_todos", {
        action: "complete",
        indices: [1],
      });
      expect(mockWindow.todoCompleted).toBe(3);

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should increment todoCompleted on edit_todos abandon", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // First write todos
      await emitToolCall("write_todos", {
        mode: "replace",
        todos: [{ text: "A" }, { text: "B" }, { text: "C" }],
      });
      expect(mockWindow.todoTotal).toBe(3);
      expect(mockWindow.todoCompleted).toBe(0);

      // Abandon indices 0 and 1
      await emitToolCall("edit_todos", {
        action: "abandon",
        indices: [0, 1],
      });
      // abandon increments todoCompleted by the number of indices
      expect(mockWindow.todoCompleted).toBe(2);

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should add to todoTotal on write_todos append mode", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Initial write
      await emitToolCall("write_todos", {
        mode: "replace",
        todos: [{ text: "A" }, { text: "B" }],
      });
      expect(mockWindow.todoTotal).toBe(2);

      // Append 3 more
      await emitToolCall("write_todos", {
        mode: "append",
        todos: [{ text: "C" }, { text: "D" }, { text: "E" }],
      });
      expect(mockWindow.todoTotal).toBe(2 + 3);

      // Append 1 more
      await emitToolCall("write_todos", {
        mode: "append",
        todos: [{ text: "F" }],
      });
      expect(mockWindow.todoTotal).toBe(2 + 3 + 1);

      // todoCompleted should remain unchanged from append
      expect(mockWindow.todoCompleted).toBe(0);

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

      await new Promise((resolve) => setTimeout(resolve, 10));

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

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      // session.messages should be capped at MAX_MESSAGES_PER_SESSION
      // The eviction logic: push then if >= MAX, shift. Steady state is MAX-1.
      expect(mockSession.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
      expect(mockSession.messages.length).toBe(MAX_MESSAGES - 1);

      // The oldest messages should have been evicted — the first message
      // should be msg-51 (index 51), not msg-0
      // 550 messages emitted, 499 retained, so first retained is index 51
      const firstRetainedIndex = totalMessages - (MAX_MESSAGES - 1);
      const firstMsgContent = (
        mockSession.messages[0].content as Array<{ type: string; text: string }>
      )[0].text;
      expect(firstMsgContent).toBe(`msg-${firstRetainedIndex}`);

      // The last message should be the most recent
      const lastMsgContent = (
        mockSession.messages[mockSession.messages.length - 1].content as Array<{
          type: string;
          text: string;
        }>
      )[0].text;
      expect(lastMsgContent).toBe(`msg-${totalMessages - 1}`);

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("loop detection", () => {
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

    it("should not detect loop when tool calls are different", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("bash", { command: "cmd1" });
      await emitToolCall("read", { path: "/a" });
      await emitToolCall("bash", { command: "cmd2" });
      await emitToolCall("write", { path: "/b", content: "x" });
      await emitToolCall("grep", { pattern: "test" });

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
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("read", { path: "/same/file.ts" });
      await emitToolCall("read", { path: "/same/file.ts" });
      await emitToolCall("read", { path: "/same/file.ts" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
      expect(mockWindow.recentToolCalls?.length).toBe(3);
    });

    it("should detect loop with highly similar tool calls", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
        loopingToolSimilarity: 0.9,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // These differ by only 1 char in the command string, producing similarity > 0.90
      await emitToolCall("bash", { command: "cat /src/index.ts" });
      await emitToolCall("bash", { command: "cat /src/index.tx" });
      await emitToolCall("bash", { command: "cat /src/index.tt" });

      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
    });

    it("should not detect loop when similarity is below threshold", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
        loopingToolCount: 3,
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // These share a prefix but differ significantly in the command body
      await emitToolCall("bash", { command: "npm run build" });
      await emitToolCall("bash", { command: "npm run test" });
      await emitToolCall("bash", { command: "npm run lint" });

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
        // No loopingToolCount — uses default of 5
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("read", { path: "/a" });
      await emitToolCall("read", { path: "/a" });
      await emitToolCall("read", { path: "/a" });
      await emitToolCall("read", { path: "/a" });

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
        // No loopingToolCount — uses default of 5
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("read", { path: "/a" });
      await emitToolCall("read", { path: "/a" });
      await emitToolCall("read", { path: "/a" });
      await emitToolCall("read", { path: "/a" });
      await emitToolCall("read", { path: "/a" });

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
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitToolCall("read", { path: "/same" });
      await emitToolCall("read", { path: "/same" });
      await emitToolCall("read", { path: "/same" });
      await emitToolCall("read", { path: "/same" });
      await emitToolCall("read", { path: "/same" });

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
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // First emit 2 different calls (not similar to each other or to the identical ones)
      await emitToolCall("bash", { command: "a" });
      await emitToolCall("bash", { command: "b" });
      // Then emit 3 identical calls — these should be detected as a loop
      await emitToolCall("read", { path: "/same" });
      await emitToolCall("read", { path: "/same" });
      await emitToolCall("read", { path: "/same" });

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
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit 3 identical calls — loop detected flag set
      await emitToolCall("read", { path: "/same" });
      await emitToolCall("read", { path: "/same" });
      await emitToolCall("read", { path: "/same" });
      // Emit a different call — flag should stay true
      await emitToolCall("bash", { command: "echo done" });

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
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit a text-only message (no toolCall parts)
      const jsonEvent = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Just text output" }] },
      });
      mockProcess.stdout.emit("data", Buffer.from(`${jsonEvent}\n`));
      await new Promise((resolve) => setTimeout(resolve, 100));

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
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit a single message with 3 identical toolCall parts
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
      await new Promise((resolve) => setTimeout(resolve, 100));

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
        loopingToolSimilarity: 0.95,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit 3 identical tool calls to trigger loop detection
      await emitToolCall("read", { path: "/same/file.ts" });
      await emitToolCall("read", { path: "/same/file.ts" });
      await emitToolCall("read", { path: "/same/file.ts" });

      // Process should have been killed with SIGTERM
      expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");

      // Resolve the promise by emitting close
      mockProcess.emit("close", 0);
      const result = await promise;
      expect(result.loopDetected).toBe(true);
    });
  });

  describe("profiles: saveProfile", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      invalidateProfilesCache();
    });

    it("creates new profile file in correct directory", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      await saveProfile(
        "my-profile",
        { provider: "anthropic", model: "claude-sonnet-4-5" },
        "global",
      );

      // Should write to global agent-profiles dir
      const writeCall = vi.mocked(writeFile).mock.calls[0];
      expect(writeCall[0]).toMatch(/agent-profiles\/my-profile\.md$/);
      expect(writeCall[1]).toContain("name: my-profile");
      expect(writeCall[2]).toBe("utf8");
    });

    it("updates existing profile", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      // First save
      await saveProfile("updatable", { provider: "anthropic" }, "global");

      // Second save with updated data
      await saveProfile("updatable", { provider: "openai", model: "gpt-4" }, "global");

      // writeFile should have been called twice to the same path
      const calls = vi.mocked(writeFile).mock.calls;
      const profileCalls = calls.filter((c) => String(c[0]).endsWith("updatable.md"));
      expect(profileCalls).toHaveLength(2);

      // Second call should have the updated content
      const secondContent = String(profileCalls[1][1]);
      expect(secondContent).toContain("provider: openai");
      expect(secondContent).toContain("model: gpt-4");
      // Should NOT contain old provider
      expect(secondContent).not.toContain("provider: anthropic");
    });

    it("creates directory if missing", async () => {
      // Directory does not exist
      vi.mocked(existsSync).mockReturnValue(false);

      await saveProfile("new-profile", { provider: "anthropic" }, "project", "/tmp/my-project");

      // mkdirSync should have been called with recursive: true
      expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining("agent-profiles"), {
        recursive: true,
      });

      // writeFile should still be called
      expect(writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(writeFile).mock.calls[0];
      expect(String(writeCall[0])).toMatch(/my-project\/\.pi\/agent-profiles\/new-profile\.md$/);
    });
  });

  describe("profiles: deleteProfile", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      invalidateProfilesCache();
    });

    it("removes file and returns true", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const result = await deleteProfile("removable", "global");

      expect(result).toBe(true);
      expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/agent-profiles\/removable\.md$/));
    });

    it("returns false for non-existent profile", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await deleteProfile("ghost", "global");

      expect(result).toBe(false);
      expect(unlink).not.toHaveBeenCalled();
    });
  });

  describe("profiles: serializeProfileToMarkdown (via saveProfile)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      invalidateProfilesCache();
      vi.mocked(existsSync).mockReturnValue(true);
    });

    /** Helper: call saveProfile and return the written markdown content */
    async function getWrittenMarkdown(
      name: string,
      profile: ProfilesModule.SubagentProfile,
    ): Promise<string> {
      await saveProfile(name, profile, "global");
      const writeCall = vi.mocked(writeFile).mock.calls[0];
      return String(writeCall[1]);
    }

    it("produces correct format with all fields", async () => {
      const md = await getWrittenMarkdown("full-profile", {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "high",
        tools: ["read", "bash", "grep"],
        excludeTools: ["write"],
        extensions: ["/ext1.js", "/ext2.js"],
        extraArgs: ["--verbose"],
        appendSystemPrompt: "Be concise",
        apiKey: "sk-test",
        noTools: false,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        systemPrompt: "You are a helpful assistant.",
      });

      // Frontmatter delimiters
      expect(md).toMatch(/^---\n/);
      expect(md).toContain("\n---\n");

      // All fields present
      expect(md).toContain("name: full-profile");
      expect(md).toContain("provider: anthropic");
      expect(md).toContain("model: claude-sonnet-4-5");
      expect(md).toContain("thinkingLevel: high");
      expect(md).toContain("tools: read,bash,grep");
      expect(md).toContain("excludeTools: write");
      expect(md).toContain("extensions: /ext1.js,/ext2.js");
      expect(md).toContain("extraArgs: --verbose");
      expect(md).toContain("appendSystemPrompt: Be concise");
      expect(md).toContain("apiKey: sk-test");
      expect(md).toContain("noTools: false");
      expect(md).toContain("noExtensions: true");
      expect(md).toContain("noSkills: true");
      expect(md).toContain("noContextFiles: true");

      // System prompt in body (after second ---)
      const bodyStart = md.indexOf("---", 4) + 3;
      const body = md.slice(bodyStart).trim();
      expect(body).toBe("You are a helpful assistant.");
    });

    it("omits undefined fields", async () => {
      const md = await getWrittenMarkdown("minimal-profile", {
        provider: "anthropic",
      });

      expect(md).toContain("name: minimal-profile");
      expect(md).toContain("provider: anthropic");

      // Should NOT contain fields that weren't set
      expect(md).not.toContain("model:");
      expect(md).not.toContain("thinkingLevel:");
      expect(md).not.toContain("tools:");
      expect(md).not.toContain("excludeTools:");
      expect(md).not.toContain("extensions:");
      expect(md).not.toContain("extraArgs:");
      expect(md).not.toContain("appendSystemPrompt:");
      expect(md).not.toContain("apiKey:");
      expect(md).not.toContain("noTools:");
      expect(md).not.toContain("noExtensions:");
      expect(md).not.toContain("noSkills:");
      expect(md).not.toContain("noContextFiles:");

      // No body (systemPrompt is undefined)
      const lines = md.trim().split("\n");
      // Last line should be the closing ---
      expect(lines[lines.length - 1]).toBe("---");
    });

    it("includes systemPrompt as body", async () => {
      const md = await getWrittenMarkdown("prompted", {
        systemPrompt: "You are a senior code reviewer.",
      });

      // System prompt should appear after the closing frontmatter ---
      const parts = md.split("---");
      // parts: ['', ' frontmatter ', ' body ', '']
      // The body section (after second ---) should contain the prompt
      const body = parts.slice(2).join("---").trim();
      expect(body).toBe("You are a senior code reviewer.");
    });
  });

  describe("stdin error handling", () => {
    it("should silently ignore EPIPE on stdin", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit an EPIPE error on stdin (should be silently ignored)
      const epipeError = new Error("EPIPE: Broken pipe") as NodeJS.ErrnoException;
      epipeError.code = "EPIPE";
      mockProcess.stdin.emit("error", epipeError);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // No [stdin error] line should appear in the window lines
      const stdinErrorLine = mockWindow.lines.find((l) => l.text.includes("[stdin error]"));
      expect(stdinErrorLine).toBeUndefined();

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should log unexpected stdin errors to stderr", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit an unknown error on stdin (should be logged)
      const unknownError = new Error("Unknown write error") as NodeJS.ErrnoException;
      unknownError.code = "UNKNOWN_ERROR";
      mockProcess.stdin.emit("error", unknownError);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // [stdin error] line should appear in the window lines
      const stdinErrorLine = mockWindow.lines.find((l) => l.text.includes("[stdin error]"));
      expect(stdinErrorLine).toBeTruthy();
      expect(stdinErrorLine?.text).toContain("[stdin error]: Unknown write error");

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("turn_end ls/find result handling", () => {
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    it("should append ls result summary", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitTurnEnd([
        {
          toolName: "ls",
          content: [{ type: "text", text: "file1.ts\nfile2.ts\ndir1/" }],
          isError: false,
        },
      ]);

      const summaryLine = mockWindow.lines.find(
        (l) => l.kind === "tool" && l.text.includes("files"),
      );
      expect(summaryLine?.text).toBe("  2 files, 1 dir");
      expect(summaryLine?.kind).toBe("tool");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should append find result summary", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await emitTurnEnd([
        {
          toolName: "find",
          content: [{ type: "text", text: "result1.ts\nresult2.ts\nresult3.ts" }],
          isError: false,
        },
      ]);

      const summaryLine = mockWindow.lines.find(
        (l) => l.kind === "tool" && l.text.includes("matches"),
      );
      expect(summaryLine?.text).toBe("  3 matches");
      expect(summaryLine?.kind).toBe("tool");

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

      await new Promise((resolve) => setTimeout(resolve, 10));

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

      await new Promise((resolve) => setTimeout(resolve, 10));

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

    it("should handle multiple tool results in single turn_end", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

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

      const lsLine = mockWindow.lines.find((l) => l.kind === "tool" && l.text.includes("files"));
      const findLine = mockWindow.lines.find(
        (l) => l.kind === "tool" && l.text.includes("matches"),
      );

      expect(lsLine?.text).toBe("  3 files");
      expect(lsLine?.kind).toBe("tool");

      expect(findLine?.text).toBe("  2 matches");
      expect(findLine?.kind).toBe("tool");

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

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit stderr data
      mockProcess.stderr.emit("data", Buffer.from("Warning: deprecated API usage\n"));

      await new Promise((resolve) => setTimeout(resolve, 100));

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
