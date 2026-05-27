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

// Mock settings module — override loadCommandPreviewWidth
// so tests are deterministic regardless of terminal width
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
import { loadCommandPreviewWidth } from "../settings";

function findToolLine(lines: Array<{ text: string }>, keyword: string) {
  const line = lines.find((l) => l.text.includes(keyword));
  if (!line) {
    throw new Error(
      `Expected to find a line containing "${keyword}" in: ${lines.map((l) => l.text).join(", ")}`,
    );
  }
  return line;
}

function findToolLines(lines: Array<{ text: string }>, keyword: string) {
  return lines.filter((l) => l.text.includes(keyword));
}

describe("spawner-tool-display", () => {
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

  describe("path shortening in tool call display", () => {
    const CWD = "/home/user/projects/my-app";

    it("should shorten bash command paths relative to cwd", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", { command: "cat /home/user/projects/my-app/src/index.ts" });

      const toolLine = findToolLine(mockWindow.lines, "bash");
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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", { command: "cd /home/user/projects/my-app && npm test" });

      const toolLine = findToolLine(mockWindow.lines, "bash");
      expect(toolLine.text).toBe("💻 bash → npm test");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "edit", {
        path: "/home/user/projects/my-app/src/utils.ts",
        edits: [{ oldText: "x", newText: "y" }],
      });

      const toolLine = findToolLine(mockWindow.lines, "edit");
      expect(toolLine.text).toBe("✏️ edit → src/utils.ts (1 edit) +1/-1");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "read", {
        path: "/home/user/projects/my-app/src/index.ts",
        offset: 10,
        limit: 20,
      });

      const toolLine = findToolLine(mockWindow.lines, "read");
      expect(toolLine.text).toBe("📖 read → src/index.ts:10+20 (20 lines)");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "write", {
        path: "/home/user/projects/my-app/src/new-file.ts",
        content: "hello",
      });

      const toolLine = findToolLine(mockWindow.lines, "write");
      expect(toolLine.text).toBe("📝 write → src/new-file.ts +1");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "lsp_diagnostics", {
        file: "/home/user/projects/my-app/src/app.tsx",
      });

      const toolLine = findToolLine(mockWindow.lines, "lsp_diagnostics");
      expect(toolLine.text).toBe("🏥 lsp_diagnostics → src/app.tsx");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "lint_files", {
        files: ["/home/user/projects/my-app/src/a.ts", "/home/user/projects/my-app/src/b.ts"],
      });

      const toolLine = findToolLine(mockWindow.lines, "lint");
      expect(toolLine.text).toBe("🧹 lint → src/a.ts, src/b.ts");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "grep", { pattern: "TODO" });

      const toolLine = findToolLine(mockWindow.lines, "grep");
      expect(toolLine.text).toBe("🔍 grep → /TODO/");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "grep", {
        pattern: "TODO",
        path: "/home/user/projects/my-app/src",
      });

      const toolLine = findToolLine(mockWindow.lines, "grep");
      expect(toolLine.text).toBe("🔍 grep → /TODO/ → src");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "grep", {
        pattern: "TODO",
        glob: "*.ts",
      });

      const toolLine = findToolLine(mockWindow.lines, "grep");
      expect(toolLine.text).toBe("🔍 grep → /TODO/ → *.ts");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "grep", {
        pattern: "TODO",
        path: "/home/user/projects/my-app/src",
        glob: "*.ts",
      });

      const toolLine = findToolLine(mockWindow.lines, "grep");
      expect(toolLine.text).toBe("🔍 grep → /TODO/ → *.ts");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "read", {
        path: "/usr/local/share/some/config.json",
      });

      const toolLine = findToolLine(mockWindow.lines, "read");
      expect(toolLine.text).toContain("/usr/local/share/some/config.json");

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("smart && splitting in bash command display", () => {
    const CWD = "/home/user/projects/my-app";

    it("should split bash command with && across lines when segments overflow a narrow width", async () => {
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(40);

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", {
        command: "npm run build && npm run test && npm run lint",
      });

      const bashLines = findToolLines(mockWindow.lines, "bash");
      expect(bashLines.length).toBe(1);
      const text = bashLines[0]!.text;

      expect(text).toContain("\n");
      expect(text).toContain("npm run build && npm run test &&");
      expect(text).toContain("npm run lint");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should truncate a single overlong segment with ellipsis when no && split points exist", async () => {
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(30);

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", {
        command: "echo 'this is a really really really long command that should be truncated'",
      });

      const toolLine = mockWindow.lines.find((l) => l.text.includes("bash"));
      expect(toolLine).toBeTruthy();
      expect(toolLine?.text).toContain("...");
      expect(toolLine?.text).not.toContain("should be truncated");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should truncate an overlong segment in the middle of a && chain", async () => {
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(40);

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", {
        command: "short && this-is-a-very-long-middle-segment-that-will-overflow && tail",
      });

      const bashLines = findToolLines(mockWindow.lines, "bash");
      const allText = bashLines.map((l) => l.text).join("\n");
      expect(allText).toContain("...");
      expect(allText).toContain("tail");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should not split when the full command fits within width budget", async () => {
      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(160);

      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "bash", {
        command: "npm test && npm run lint",
      });

      const bashLines = findToolLines(mockWindow.lines, "bash");
      expect(bashLines.length).toBe(1);
      expect(bashLines[0]!.text).toBe("💻 bash → npm test && npm run lint");

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("formatToolCall default case", () => {
    const CWD = "/home/user/projects/my-app";

    it("should render unknown tool with empty args as just toolName", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "my_tool", {});
      const toolLine = findToolLine(mockWindow.lines, "my_tool");
      expect(toolLine.text).toBe("🔧 my_tool");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "custom_tool", { target: "build-output" });
      const toolLine = findToolLine(mockWindow.lines, "custom_tool");
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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "multi_arg_tool", { a: 1, b: "two", c: true });
      const toolLine = findToolLine(mockWindow.lines, "multi_arg_tool");
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

      vi.mocked(loadCommandPreviewWidth).mockResolvedValueOnce(30);

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      const longValue = "x".repeat(200);
      emitToolCall(mockProcess, "big_tool", { data: longValue });
      const toolLine = findToolLine(mockWindow.lines, "big_tool");
      expect(toolLine.text).toContain("big_tool");
      expect(toolLine.text).toContain("...");
      expect(toolLine.text).not.toContain(longValue);

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("todo tool renderers", () => {
    const CWD = "/home/user/projects/my-app";

    it("should render write_todos with count", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "write_todos", {
        mode: "replace",
        todos: [{ text: "Task A" }, { text: "Task B" }],
      });
      const writeLine = findToolLine(mockWindow.lines, "write_todos");
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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "edit_todos", {
        action: "complete",
        indices: [0, 2, 4],
      });
      const editLine = findToolLine(mockWindow.lines, "edit_todos");
      expect(editLine.text).toContain("edit_todos → complete [0,2,4]");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "list_todos", {});
      const listLine = findToolLine(mockWindow.lines, "list_todos");
      expect(listLine.text).toBe("✅ list_todos");

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("tool count and todo tracking in handleStdoutLine", () => {
    const CWD = "/home/user/projects/my-app";

    it("should not modify toolCount during tool calls (set at window creation)", async () => {
      mockWindow.toolCount = 25;
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt", cwd: CWD },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      expect(mockWindow.toolCount).toBe(25);

      emitToolCall(mockProcess, "bash", { command: "echo hello" });
      expect(mockWindow.toolCount).toBe(25);

      emitToolCall(mockProcess, "read", { path: "/some/file.ts" });
      expect(mockWindow.toolCount).toBe(25);

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      expect(mockWindow.todoTotal).toBeUndefined();
      expect(mockWindow.todoCompleted).toBeUndefined();

      emitToolCall(mockProcess, "write_todos", {
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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "write_todos", {
        mode: "replace",
        todos: [{ text: "A" }, { text: "B" }, { text: "C" }],
      });
      expect(mockWindow.todoTotal).toBe(3);
      expect(mockWindow.todoCompleted).toBe(0);

      emitToolCall(mockProcess, "edit_todos", {
        action: "complete",
        indices: [0, 2],
      });
      expect(mockWindow.todoCompleted).toBe(2);

      emitToolCall(mockProcess, "edit_todos", {
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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "write_todos", {
        mode: "replace",
        todos: [{ text: "A" }, { text: "B" }, { text: "C" }],
      });
      expect(mockWindow.todoTotal).toBe(3);
      expect(mockWindow.todoCompleted).toBe(0);

      emitToolCall(mockProcess, "edit_todos", {
        action: "abandon",
        indices: [0, 1],
      });
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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      emitToolCall(mockProcess, "write_todos", {
        mode: "replace",
        todos: [{ text: "A" }, { text: "B" }],
      });
      expect(mockWindow.todoTotal).toBe(2);

      emitToolCall(mockProcess, "write_todos", {
        mode: "append",
        todos: [{ text: "C" }, { text: "D" }, { text: "E" }],
      });
      expect(mockWindow.todoTotal).toBe(2 + 3);

      emitToolCall(mockProcess, "write_todos", {
        mode: "append",
        todos: [{ text: "F" }],
      });
      expect(mockWindow.todoTotal).toBe(2 + 3 + 1);

      expect(mockWindow.todoCompleted).toBe(0);

      mockProcess.emit("close", 0);
      await promise;
    });
  });
});
