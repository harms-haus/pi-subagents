import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubAgent } from "../spawner";
import type { SubAgentWindow, SubagentSessionData } from "../types";
import type * as ProfilesModule from "../profiles";
import { createMockProcess, waitForCondition } from "./helpers";

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

// Mock tree-kill (used by spawner for process termination)
vi.mock("tree-kill", () => ({
  default: vi.fn(),
}));

import { existsSync, mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import kill from "tree-kill";
import { isAbsolute, sep } from "node:path";
import { deleteProfile, invalidateProfilesCache, saveProfile } from "../profiles";
import { serializeProfileToMarkdown } from "../profile-formatting";

// loadCommandPreviewWidth is imported by the mock above; not used directly in this file
// but must be mocked for spawner to work

describe("spawner-core", () => {
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

  describe("runSubAgent", () => {
    it("should spawn with correct arguments", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      expect(spawn).toHaveBeenCalled();
      const spawnArgs = vi.mocked(spawn).mock.calls[0]!;
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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      expect(spawn).toHaveBeenCalled();
      const spawnOptions = vi.mocked(spawn).mock.calls[0]![2];
      expect(isAbsolute(spawnOptions.cwd as string)).toBe(true);
      expect(
        (spawnOptions.cwd as string).endsWith(`absolute${sep}path`) ||
          (spawnOptions.cwd as string).endsWith("/absolute/path"),
      ).toBe(true);

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      expect(spawn).toHaveBeenCalled();
      const spawnOptions = vi.mocked(spawn).mock.calls[0]![2];
      // The path is normalized by resolve()
      expect(isAbsolute(spawnOptions.cwd as string)).toBe(true);
      expect((spawnOptions.cwd as string).endsWith("unsafe")).toBe(true);

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // spawn should be called because resolve() makes relative paths absolute
      // validateCwd will resolve the relative path to absolute
      expect(spawn).toHaveBeenCalled();
      const spawnOptions = vi.mocked(spawn).mock.calls[0]![2];
      expect(spawnOptions.cwd).toBeTruthy();
      expect(isAbsolute(spawnOptions.cwd as string)).toBe(true);
      expect(spawnOptions.cwd).toContain("relative");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      mockProcess.emit("close", 0);
      await promise;

      expect(mockWindow.exitCode).toBe(0);
      // Process exited with code 0 but produced no message_end events — bare exit detection
      expect(mockWindow.status).toBe("error");
      expect(mockWindow.errorMessage).toMatch(/no output/i);
    });

    it("should handle process exit with non-zero code", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      mockProcess.emit("close", 1);
      await promise;

      expect(mockWindow.exitCode).toBe(1);
      expect(mockWindow.status).toBe("error");
    });

    it("should flush remaining buffer on process exit", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Send data without a trailing newline so it stays in the buffer
      mockProcess.stdout.emit("data", Buffer.from("leftover line"));

      // Buffer should contain the partial line, not yet processed
      expect(mockWindow.lines).toHaveLength(0);

      // Close the process — buffer should be flushed and processed
      mockProcess.emit("close", 0);
      await promise;

      // The leftover buffer should have been processed as a line
      expect(mockWindow.lines.some((l) => l.text.includes("leftover line"))).toBe(true);
      // Process exited with code 0 but produced no message_end events — bare exit detection
      expect(mockWindow.status).toBe("error");
      expect(mockWindow.errorMessage).toMatch(/no output/i);
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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Abort the process
      abortController.abort();

      await waitForCondition(() => vi.mocked(kill).mock.calls.length > 0);

      expect(kill).toHaveBeenCalledWith(mockProcess.pid, "SIGTERM");

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should escalate from SIGTERM to SIGKILL after 5s if process does not die", async () => {
      vi.useFakeTimers();

      // Create a process where the tree-kill mock simulates an unresponsive
      // process that ignores SIGTERM — only SIGKILL takes effect
      const escalationProc = createMockProcess();
      vi.mocked(kill).mockImplementation((_pid: number, signal?: string | number) => {
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
      expect(kill).toHaveBeenCalledWith(escalationProc.pid, "SIGTERM");
      expect(escalationProc.killed).toBe(false);

      // Advance past the 5-second escalation timeout
      await vi.advanceTimersByTimeAsync(6000);

      // SIGKILL should now have been sent
      expect(kill).toHaveBeenCalledWith(escalationProc.pid, "SIGKILL");
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

      await waitForCondition(() => vi.mocked(kill).mock.calls.length > 0);

      expect(kill).toHaveBeenCalledWith(mockProcess.pid, "SIGTERM");

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      expect(spawn).toHaveBeenCalled();
      const spawnArgs = vi.mocked(spawn).mock.calls[0]![1];

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      expect(spawn).toHaveBeenCalled();
      const spawnArgs = vi.mocked(spawn).mock.calls[0]![1];

      // Profile should inject additional args and env vars
      // Prompt is passed via stdin via end(), not as CLI arg
      expect(spawnArgs).not.toContain("test prompt");
      expect(mockProcess.stdin.end).toHaveBeenCalledWith(expect.stringContaining("test prompt"));

      const spawnOptions = vi.mocked(spawn).mock.calls[0]![2];
      expect(spawnOptions.env).toBeDefined();

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("stdin error handling", () => {
    it("should handle EPIPE on stdin without crashing", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit an EPIPE error on stdin (should be silently ignored)
      const epipeError = new Error("EPIPE: Broken pipe") as NodeJS.ErrnoException;
      epipeError.code = "EPIPE";
      mockProcess.stdin.emit("error", epipeError);

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

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit an unknown error on stdin (should be logged)
      const unknownError = new Error("Unknown write error") as NodeJS.ErrnoException;
      unknownError.code = "UNKNOWN_ERROR";
      mockProcess.stdin.emit("error", unknownError);

      // [stdin error] line should appear in the window lines (synchronous)
      const stdinErrorLine = mockWindow.lines.find((l) => l.text.includes("[stdin error]"));
      expect(stdinErrorLine).toBeTruthy();
      expect(stdinErrorLine?.text).toContain("[stdin error]: Unknown write error");

      mockProcess.emit("close", 0);
      await promise;
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

      // Should write to global profiles dir
      const writeCall = vi.mocked(writeFile).mock.calls[0]!;
      expect(writeCall[0]).toMatch(/profiles\/my-profile\.md$/);
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
      const profileCalls = calls.filter((c) => (c[0] as string).endsWith("updatable.md"));
      expect(profileCalls).toHaveLength(2);

      // Second call should have the updated content
      const secondContent = profileCalls[1]![1] as string;
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
      expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining("profiles"), {
        recursive: true,
      });

      // writeFile should still be called
      expect(writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(writeFile).mock.calls[0]!;
      expect(writeCall[0] as string).toMatch(/my-project\/\.pi\/agent\/profiles\/new-profile\.md$/);
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
      expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/profiles\/removable\.md$/));
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
      const writeCall = vi.mocked(writeFile).mock.calls[0]!;
      return writeCall[1] as string;
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

  describe("error handling improvements", () => {
    it("should capture the actual error message from spawn error event", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit an error event with a specific error message
      const spawnError = new Error("spawn ENOENT pi not found");
      mockProcess.emit("error", spawnError);
      await promise;

      expect(mockWindow.exitCode).toBe(1);
      expect(mockWindow.status).toBe("error");
      // The errorMessage should include the actual error details, not just the generic message
      expect(mockWindow.errorMessage).toContain("ENOENT");
      expect(mockWindow.errorMessage).toContain("pi not found");
    });

    it("should set exitCode to -1 when process is killed by signal (code is null)", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit 'close' with null code (signal kill, e.g. SIGTERM)
      mockProcess.emit("close", null);
      await promise;

      expect(mockWindow.exitCode).toBe(-1);
      expect(mockWindow.status).toBe("error");
    });

    it("should detect bare exit with code 0 and no output as error", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Process exits with code 0 but produced zero output (no message_end events)
      expect(mockSession.messages).toHaveLength(0);
      mockProcess.emit("close", 0);
      await promise;

      // Should be detected as error — no output means nothing useful happened
      expect(mockWindow.status).toBe("error");
      expect(mockWindow.errorMessage).toBeDefined();
      expect(mockWindow.errorMessage).not.toBe("");
      expect(mockWindow.errorMessage).toMatch(/no output/i);
    });

    it("should include stderr content in errorMessage on non-zero exit", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit stderr data before the process exits
      mockProcess.stderr.emit("data", Buffer.from("FATAL: API key not configured"));

      // Process exits with non-zero code
      mockProcess.emit("close", 1);
      await promise;

      expect(mockWindow.status).toBe("error");
      // The stderr content should be captured as error context when no other error message is set
      expect(mockWindow.errorMessage).toContain("API key not configured");
    });

    it("should show diagnostic line in win.lines for EPIPE on stdin", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      // Emit an EPIPE error on stdin
      const epipeError = new Error("write EPIPE") as NodeJS.ErrnoException;
      epipeError.code = "EPIPE";
      mockProcess.stdin.emit("error", epipeError);

      // A diagnostic line should appear in win.lines indicating the pipe issue
      const diagnosticLine = mockWindow.lines.find(
        (l) => l.text.includes("EPIPE") || l.text.includes("pipe") || l.text.includes("stdin"),
      );
      expect(diagnosticLine).toBeDefined();
      expect(diagnosticLine?.text).toMatch(/EPIPE|pipe|stdin/);

      mockProcess.emit("close", 0);
      await promise;
    });

    it("should silently ignore unknown JSON event types", async () => {
      const promise = runSubAgent({
        task: { name: "test-task", prompt: "test prompt" },
        win: mockWindow,
        maxLines: 100,
        onUpdate: onUpdateSpy,
        session: mockSession,
      });

      await waitForCondition(() => vi.mocked(spawn).mock.calls.length > 0);

      const linesBefore = mockWindow.lines.length;

      // Emit a JSON event with an unknown type
      const unknownEvent = JSON.stringify({
        type: "error",
        message: "API auth failed",
      });
      mockProcess.stdout.emit("data", Buffer.from(`${unknownEvent}\n`));

      // Unknown JSON events are silently dropped — not surfaced in lines
      expect(mockWindow.lines.length).toBe(linesBefore);

      mockProcess.emit("close", 0);
      await promise;
    });
  });

  describe("yamlQuote: special characters in frontmatter values", () => {
    it("quotes values containing colons", () => {
      const md = serializeProfileToMarkdown("my-profile", {
        systemPrompt: "Hello",
        appendSystemPrompt: "Note: see http://example.com for details",
      });
      // The appendSystemPrompt value should be quoted
      expect(md).toContain('appendSystemPrompt: "Note: see http://example.com for details"');
    });

    it("quotes values containing hashes", () => {
      const md = serializeProfileToMarkdown("my-profile", {
        systemPrompt: "Hello",
        provider: "my#provider",
      });
      expect(md).toContain('provider: "my#provider"');
    });

    it("quotes values containing double quotes", () => {
      const md = serializeProfileToMarkdown("my-profile", {
        systemPrompt: 'He said "hello" and left',
      });
      // Body should contain the full prompt
      const bodyStart = md.indexOf("---", 4) + 3;
      const body = md.slice(bodyStart).trim();
      expect(body).toBe('He said "hello" and left');
    });

    it("quotes values containing newlines", () => {
      const md = serializeProfileToMarkdown("my-profile", {
        systemPrompt: "Hello",
        appendSystemPrompt: "line1\nline2",
      });
      expect(md).toContain('appendSystemPrompt: "line1\nline2"');
    });

    it("quotes values with leading/trailing whitespace", () => {
      const md = serializeProfileToMarkdown("my-profile", {
        systemPrompt: "Hello",
        appendSystemPrompt: " spaced ",
      });
      expect(md).toContain('appendSystemPrompt: " spaced "');
    });

    it("does not quote simple safe values", () => {
      const md = serializeProfileToMarkdown("simple-profile", {
        systemPrompt: "Hello",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      });
      expect(md).toContain("name: simple-profile");
      expect(md).toContain("provider: anthropic");
      expect(md).toContain("model: claude-sonnet-4-5");
      // Should NOT have any quoted values
      const fmLines = md.split("---")[1];
      expect(fmLines).not.toMatch(/"[^"]+"/);
    });

    it("escapes backslashes and quotes inside quoted values", () => {
      const md = serializeProfileToMarkdown("my-profile", {
        systemPrompt: "Hello",
        appendSystemPrompt: 'path\\to\\file and "quoted"',
      });
      expect(md).toContain('appendSystemPrompt: "path\\\\to\\\\file and \\"quoted\\""');
    });

    it("round-trip: special chars in name are quoted", () => {
      const md = serializeProfileToMarkdown("my:profile", {
        systemPrompt: "Hello",
      });
      expect(md).toContain('name: "my:profile"');
    });
  });
});
