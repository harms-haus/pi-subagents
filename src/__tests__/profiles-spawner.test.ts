/**
 * Tests for profiles.ts (save/delete/serialize) and spawner.ts (formatToolCall branches, handleStderrData).
 *
 * Bifrost rune: bf-f819.3.7
 */

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubAgent } from "../spawner";
import type { SubAgentWindow, SubagentSessionData } from "../types";
import type * as ProfilesModule from "../profiles";

// ── Mocks (same pattern as spawner.test.ts) ──────────────────────────

// Mock pi-coding-agent (used by profiles.ts for parseFrontmatter)
vi.mock("@earendil-works/pi-coding-agent", () => ({
  parseFrontmatter: vi.fn((content: string) => {
    const lines = content.split("\n");
    return { frontmatter: {}, body: lines.slice(2).join("\n") };
  }),
}));

// Mock profiles module — keep real implementations but override loadCommandPreviewWidth
vi.mock("../profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof ProfilesModule>();
  return {
    ...actual,
    loadCommandPreviewWidth: vi.fn().mockResolvedValue(160),
  };
});

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

// Mock child_process.spawn (used by spawner.ts)
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { existsSync, mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { deleteProfile, invalidateProfilesCache, saveProfile } from "../profiles";

// ── Helper: mock ChildProcess ────────────────────────────────────────

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

// ── profiles.ts tests ────────────────────────────────────────────────

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
    await saveProfile(
      "updatable",
      { provider: "anthropic" },
      "global",
    );

    // Second save with updated data
    await saveProfile(
      "updatable",
      { provider: "openai", model: "gpt-4" },
      "global",
    );

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

    await saveProfile(
      "new-profile",
      { provider: "anthropic" },
      "project",
      "/tmp/my-project",
    );

    // mkdirSync should have been called with recursive: true
    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("agent-profiles"),
      { recursive: true },
    );

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
    expect(unlink).toHaveBeenCalledWith(
      expect.stringMatching(/agent-profiles\/removable\.md$/),
    );
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

// ── spawner.ts tests ─────────────────────────────────────────────────

describe("spawner: formatToolCall remaining branches", () => {
  let mockProcess: ReturnType<typeof createMockProcess>;
  let mockWindow: SubAgentWindow;
  let mockSession: SubagentSessionData;
  let onUpdateSpy: ReturnType<typeof vi.fn>;

  const CWD = "/home/user/projects/my-app";

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
    };

    mockSession = {
      sessionId: "test-session-id",
      taskName: "test-task",
      prompt: "test prompt",
      cwd: CWD,
      status: "running",
      messages: [],
      exitCode: null,
      startedAt: Date.now(),
    };

    onUpdateSpy = vi.fn();
  });

  /** Emit a tool call and return when processed */
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

  /** Start a runSubAgent session (must await the promise after tests) */
  function startRun(cwd = CWD) {
    const promise = runSubAgent({
      task: { name: "test-task", prompt: "test prompt", cwd },
      win: mockWindow,
      maxLines: 100,
      onUpdate: onUpdateSpy,
      session: mockSession,
    });
    return {
      promise,
      finish: async () => {
        mockProcess.emit("close", 0);
        await promise;
      },
    };
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

  it("formatToolCall for write tool", async () => {
    const { finish } = startRun();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await emitToolCall("write", {
      path: "/home/user/projects/my-app/src/new-file.ts",
      content: "hello world",
    });

    const toolLine = findToolLine("write");
    expect(toolLine.text).toContain("write → src/new-file.ts");

    await finish();
  });

  it("formatToolCall for delegate_to_subagents (with profiles)", async () => {
    const { finish } = startRun();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await emitToolCall("delegate_to_subagents", {
      tasks: [
        { profile: "code-reviewer" },
        { profile: "test-writer" },
        { profile: "doc-writer" },
      ],
    });

    const toolLine = findToolLine("delegate_to_subagents");
    expect(toolLine.text).toContain("3 tasks");
    expect(toolLine.text).toContain("[code-reviewer, test-writer, doc-writer]");

    await finish();
  });

  it("formatToolCall for todo tools (write_todos, edit_todos, list_todos)", async () => {
    const { finish } = startRun();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // write_todos
    await emitToolCall("write_todos", {
      todos: [
        { text: "Task A" },
        { text: "Task B" },
        { text: "Task C" },
      ],
    });
    const writeLine = findToolLine("write_todos");
    expect(writeLine.text).toContain("write_todos → 3 todos");

    // edit_todos
    await emitToolCall("edit_todos", {
      action: "complete",
      indices: [0, 2],
    });
    const editLine = findToolLine("edit_todos");
    expect(editLine.text).toContain("edit_todos → complete [0,2]");

    // list_todos
    await emitToolCall("list_todos", {});
    const listLine = findToolLine("list_todos");
    expect(listLine.text).toContain("list_todos");

    await finish();
  });

  it("formatToolCall for LSP tools (lsp_find_references, lsp_goto_definition)", async () => {
    const { finish } = startRun();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // lsp_find_references
    await emitToolCall("lsp_find_references", {
      file: "/home/user/projects/my-app/src/utils.ts",
      line: 42,
      column: 10,
    });
    const refLine = findToolLine("lsp_find_references");
    expect(refLine.text).toContain("lsp_find_references → src/utils.ts:42:10");

    // lsp_goto_definition
    await emitToolCall("lsp_goto_definition", {
      file: "/home/user/projects/my-app/src/index.ts",
      line: 15,
      column: 8,
    });
    const defLine = findToolLine("lsp_goto_definition");
    expect(defLine.text).toContain("lsp_goto_definition → src/index.ts:15:8");

    await finish();
  });

  it("formatToolCall for fetch tools (fetch_content, web_search)", async () => {
    const { finish } = startRun();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // fetch_content
    await emitToolCall("fetch_content", {
      url: "https://example.com/docs",
    });
    const fetchLine = findToolLine("fetch_content");
    expect(fetchLine.text).toContain("fetch_content → https://example.com/docs");

    // web_search
    await emitToolCall("web_search", {
      query: "vitest mock patterns",
    });
    const searchLine = findToolLine("web_search");
    expect(searchLine.text).toContain("web_search → vitest mock patterns");

    await finish();
  });

  it("formatToolCall for workflow_step", async () => {
    const { finish } = startRun();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await emitToolCall("workflow_step", {
      action: "execute",
      step: "build",
      params: { target: "production" },
    });

    const stepLine = findToolLine("workflow_step");
    expect(stepLine.text).toContain("workflow_step → execute");

    await finish();
  });

  it("formatToolCall default fallback", async () => {
    const { finish } = startRun();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // An unknown tool with short first arg
    await emitToolCall("custom_tool", {
      target: "build-output",
    });

    const customLine = findToolLine("custom_tool");
    expect(customLine.text).toContain("custom_tool → build-output");

    // An unknown tool with no args
    await emitToolCall("mystery_tool", {});
    const mysteryLine = findToolLine("mystery_tool");
    expect(mysteryLine.text).toBe("→ mystery_tool");

    await finish();
  });

  it("handleStderrData processes stderr buffer", async () => {
    const { finish } = startRun();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Emit stderr data
    mockProcess.stderr.emit("data", Buffer.from("Warning: deprecated API usage\n"));

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should appear in window lines with [stderr] prefix
    const stderrLine = findToolLine("[stderr]");
    expect(stderrLine.text).toContain("[stderr]: Warning: deprecated API usage");

    // onUpdate should have been called
    expect(onUpdateSpy).toHaveBeenCalled();

    await finish();
  });
});
