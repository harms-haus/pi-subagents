import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProfile, resolveProfileSkills, validateProfileSkills } from "../profiles";
import { runSubAgent } from "../spawner";
import { registerDelegateTool } from "../tools/delegate";
import type { SessionRecord, SubagentSessionData, WindowedSubagentDetails } from "../types";
import { createMockPi } from "./helpers";

// Mock the TUI components
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
    Union: vi.fn(() => ({})),
  },
}));

// Mock skill-discovery to prevent real filesystem/npm I/O
vi.mock("../skill-discovery", () => ({
  resolvePackageSkillPaths: vi.fn().mockResolvedValue([]),
}));

// Mock the spawner
vi.mock("../spawner", () => ({
  runSubAgent: vi.fn().mockResolvedValue({ loopDetected: false }),
}));

// Mock the profiles module
vi.mock("../profiles", () => ({
  loadProfiles: vi.fn().mockReturnValue({}),
  resolveProfile: vi.fn(),
  profileSummary: vi.fn().mockReturnValue("profile-summary"),
  resolveProfileSkills: vi.fn(async (profile: unknown) => profile),
  validateProfileTools: (
    profile: { tools?: string[]; excludeTools?: string[] },
    profileName?: string,
  ) => {
    if (
      profile.tools &&
      profile.tools.length > 0 &&
      profile.excludeTools &&
      profile.excludeTools.length > 0
    ) {
      throw new Error(
        `Profile${profileName ? ` "${profileName}"` : ""} has both "tools" (allowlist) and "excludeTools" (blacklist) set. These are mutually exclusive — choose one or the other.`,
      );
    }
  },
  validateProfileSkills: vi.fn(),
  applyExcludeTools: (profile: Record<string, unknown>, allToolNames: string[]) => {
    const excludeTools = profile.excludeTools as string[] | undefined;
    if (!excludeTools || excludeTools.length === 0) {
      return profile;
    }
    const excludeSet = new Set(excludeTools);
    const computedTools = allToolNames.filter((name) => !excludeSet.has(name));
    return { ...profile, tools: computedTools, excludeTools: undefined };
  },
}));

// Mock the settings module
vi.mock("../settings", () => ({
  loadMaxLinesPerWindow: vi.fn().mockResolvedValue(15),
  loadExtendTimeoutDebounce: vi.fn().mockResolvedValue(30),
  loadLoopingToolCount: vi.fn().mockResolvedValue(5),
}));

const { mockReadFile, mockStat } = vi.hoisted(() => ({
  mockReadFile: vi.fn().mockResolvedValue("file content here\n"),
  mockStat: vi.fn().mockResolvedValue({ size: 100 }),
}));
vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  stat: mockStat,
}));

describe("delegate-features", () => {
  let mockPi: ExtensionAPI;
  let sessionStore: Map<string, SessionRecord>;

  const getDelegateExecute = () => {
    const mockRegisterSession = vi.fn();
    const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
    registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);
    const toolRegistration = vi
      .mocked(mockPi.registerTool)
      .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
    expect(toolRegistration).toBeDefined();
    return toolRegistration![0].execute;
  };

  beforeEach(() => {
    sessionStore = new Map();
    mockPi = createMockPi();
    vi.mocked(runSubAgent).mockClear();
    vi.mocked(runSubAgent).mockResolvedValue({ loopDetected: false });
    mockReadFile.mockResolvedValue("file content here\n");
    mockStat.mockResolvedValue({ size: 100 });
  });

  // ── excludeTools Resolution ─────────────────────────────────────

  describe("delegate_to_subagents - excludeTools resolution", () => {
    it("should compute tools allowlist from excludeTools and getAllTools", async () => {
      vi.mocked(mockPi.getAllTools).mockReturnValue([
        {
          name: "read",
          description: "",
          parameters: {},
          sourceInfo: { path: "", source: "", scope: "user", origin: "top-level" },
        },
        {
          name: "bash",
          description: "",
          parameters: {},
          sourceInfo: { path: "", source: "", scope: "user", origin: "top-level" },
        },
        {
          name: "write",
          description: "",
          parameters: {},
          sourceInfo: { path: "", source: "", scope: "user", origin: "top-level" },
        },
      ]);

      vi.mocked(resolveProfile).mockReturnValue({
        excludeTools: ["bash"],
      });

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "test prompt", profile: "restricted" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.profile).toBeDefined();
      expect(callArgs.profile?.tools).toEqual(["read", "write"]);
      expect(callArgs.profile?.excludeTools).toBeUndefined();
    });

    it("should throw an error when profile has both tools and excludeTools", async () => {
      vi.mocked(resolveProfile).mockReturnValue({
        tools: ["read"],
        excludeTools: ["bash"],
      });

      const executeFn = getDelegateExecute();

      await expect(
        executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", profile: "conflicted" }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        ),
      ).rejects.toThrow(/mutually exclusive/i);
    });
  });

  // ── Unknown Profile Handling ────────────────────────────────────

  describe("delegate_to_subagents - unknown profile", () => {
    it("should set error status when profile name does not exist", async () => {
      vi.mocked(resolveProfile).mockReturnValue(undefined);
      const { loadProfiles } = await import("../profiles");
      vi.mocked(loadProfiles).mockReturnValueOnce({
        "code-reviewer": { model: "anthropic/claude-sonnet-4" },
        "fast-worker": { provider: "openai" },
      });

      const executeFn = getDelegateExecute();

      const result = await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "test prompt", profile: "nonexistent" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).not.toHaveBeenCalled();

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("error");
      expect(text).toContain("Unknown profile");

      const details = result.details as WindowedSubagentDetails;
      expect(details.windows[0]!.status).toBe("error");
      expect(details.windows[0]!.errorMessage).toContain("Unknown profile");
      expect(details.windows[0]!.errorMessage).toContain("nonexistent");
    });
  });

  // ── Skill Resolution ────────────────────────────────────────────

  describe("delegate_to_subagents - skill resolution", () => {
    beforeEach(() => {
      vi.mocked(resolveProfileSkills).mockClear();
      vi.mocked(resolveProfileSkills).mockImplementation(
        async (profile: unknown) => profile as Record<string, unknown>,
      );
      vi.mocked(validateProfileSkills).mockClear();
      vi.mocked(validateProfileSkills).mockImplementation(() => {});
    });

    it("should pass resolved skill paths to runSubAgent via profile", async () => {
      vi.mocked(resolveProfile).mockReturnValue({
        suggestedSkills: ["my-skill"],
      });

      vi.mocked(resolveProfileSkills).mockImplementation(async (profile: unknown) => {
        const p = profile as Record<string, unknown>;
        return {
          ...p,
          suggestedSkills: ["/skills/my-skill/SKILL.md"],
        };
      });

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "skill-task", prompt: "do work", profile: "skilled" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(resolveProfileSkills).toHaveBeenCalledTimes(1);
      expect(resolveProfileSkills).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedSkills: ["my-skill"] }),
        process.cwd(),
        expect.any(Map),
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.profile).toBeDefined();
      expect(callArgs.profile!.suggestedSkills).toEqual(["/skills/my-skill/SKILL.md"]);
    });

    it("should set error status when skill name is not found", async () => {
      vi.mocked(resolveProfile).mockReturnValue({
        suggestedSkills: ["missing-skill"],
      });

      vi.mocked(resolveProfileSkills).mockImplementation(async () => {
        throw new Error('Skill "missing-skill" not found');
      });

      const executeFn = getDelegateExecute();

      const result = await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "bad-skill-task", prompt: "do work", profile: "skilled" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).not.toHaveBeenCalled();

      const details = result.details as WindowedSubagentDetails;
      expect(details.windows[0]!.status).toBe("error");
      expect(details.windows[0]!.errorMessage).toContain('Skill "missing-skill" not found');

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("error");
      expect(text).toContain('Skill "missing-skill" not found');
    });

    it("should not call resolveProfileSkills when profile has no skills", async () => {
      vi.mocked(resolveProfile).mockReturnValue({
        model: "anthropic/claude-sonnet-4",
      });

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "plain-task", prompt: "do work", profile: "plain" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(resolveProfileSkills).not.toHaveBeenCalled();

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.profile).toEqual({ model: "anthropic/claude-sonnet-4" });
    });

    it("should validate skill conflicts before delegation", async () => {
      vi.mocked(resolveProfile).mockReturnValue({
        suggestedSkills: ["my-skill"],
        noSkills: true,
      });

      vi.mocked(validateProfileSkills).mockImplementation(
        (profile: unknown, profileName?: string) => {
          const p = profile as Record<string, unknown>;
          if (p.suggestedSkills && p.noSkills) {
            throw new Error(
              `Profile${profileName ? ` "${profileName}"` : ""} has both "suggestedSkills" and "noSkills" set. These are mutually exclusive — --no-skills would override --skill flags.`,
            );
          }
        },
      );

      const executeFn = getDelegateExecute();

      await expect(
        executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "conflicted-task", prompt: "do work", profile: "conflicted" }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        ),
      ).rejects.toThrow(/mutually exclusive/i);

      expect(runSubAgent).not.toHaveBeenCalled();
    });

    it("should resolve skills independently per task", async () => {
      vi.mocked(resolveProfile)
        .mockReturnValueOnce({ suggestedSkills: ["skill-a"] })
        .mockReturnValueOnce({ suggestedSkills: ["skill-b"] });

      vi.mocked(resolveProfileSkills)
        .mockImplementationOnce(async (profile: unknown) => ({
          ...(profile as Record<string, unknown>),
          suggestedSkills: ["/a/SKILL.md"],
        }))
        .mockImplementationOnce(async (profile: unknown) => ({
          ...(profile as Record<string, unknown>),
          suggestedSkills: ["/b/SKILL.md"],
        }));

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            { name: "task-a", prompt: "work a", profile: "profile-a" },
            { name: "task-b", prompt: "work b", profile: "profile-b" },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(resolveProfileSkills).toHaveBeenCalledTimes(2);

      expect(resolveProfileSkills).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ suggestedSkills: ["skill-a"] }),
        process.cwd(),
        expect.any(Map),
      );
      expect(resolveProfileSkills).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ suggestedSkills: ["skill-b"] }),
        process.cwd(),
        expect.any(Map),
      );

      expect(runSubAgent).toHaveBeenCalledTimes(2);

      const call0 = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(call0.profile!.suggestedSkills).toEqual(["/a/SKILL.md"]);

      const call1 = vi.mocked(runSubAgent).mock.calls[1]![0];
      expect(call1.profile!.suggestedSkills).toEqual(["/b/SKILL.md"]);
    });

    it("should allow other tasks to continue when one task's skill resolution fails", async () => {
      vi.mocked(resolveProfile)
        .mockReturnValueOnce({ suggestedSkills: ["bad-skill"] })
        .mockReturnValueOnce({ suggestedSkills: ["good-skill"] });

      vi.mocked(resolveProfileSkills)
        .mockImplementationOnce(async () => {
          throw new Error('Skill "bad-skill" not found');
        })
        .mockImplementationOnce(async (profile: unknown) => ({
          ...(profile as Record<string, unknown>),
          suggestedSkills: ["/good/SKILL.md"],
        }));

      const executeFn = getDelegateExecute();

      const result = await executeFn(
        "tool-call-id",
        {
          tasks: [
            { name: "failing-task", prompt: "fails", profile: "bad-profile" },
            { name: "succeeding-task", prompt: "succeeds", profile: "good-profile" },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.task.name).toBe("succeeding-task");
      expect(callArgs.profile!.suggestedSkills).toEqual(["/good/SKILL.md"]);

      const details = result.details as WindowedSubagentDetails;
      const failWindow = details.windows.find((w) => w.name === "failing-task");
      const successWindow = details.windows.find((w) => w.name === "succeeding-task");

      expect(failWindow?.status).toBe("error");
      expect(failWindow?.errorMessage).toContain('Skill "bad-skill" not found');
      expect(successWindow?.status).not.toBe("error");
    });
  });

  // ── Files Parameter Handling ────────────────────────────────────

  describe("delegate_to_subagents - files parameter", () => {
    it("should prepend file contents before the prompt", async () => {
      mockReadFile.mockResolvedValue("hello world\n");

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "do the thing", files: ["src/foo.ts"] }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("=== src/foo.ts ===");
      expect(prompt).toContain("hello world");
      const fileIdx = prompt.indexOf("=== src/foo.ts ===");
      const promptIdx = prompt.indexOf("do the thing");
      expect(fileIdx).toBeLessThan(promptIdx);
    });

    it("should handle missing files with placeholder", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "do the thing", files: ["missing.ts"] }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("[file not found: missing.ts]");
    });

    it("should handle read errors with placeholder", async () => {
      mockReadFile.mockRejectedValue(new Error("permission denied"));

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "do the thing", files: ["no-access.ts"] }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("[could not read file: no-access.ts]");
    });

    it("should apply head slicing", async () => {
      mockReadFile.mockResolvedValue("line1\nline2\nline3\nline4\nline5\n");

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              files: [{ path: "src/foo.ts", head: 2 }],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("line1");
      expect(prompt).toContain("line2");
      expect(prompt).not.toContain("line3");
    });

    it("should apply tail slicing", async () => {
      mockReadFile.mockResolvedValue("line1\nline2\nline3\nline4\nline5\n");

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              files: [{ path: "src/foo.ts", tail: 2 }],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).not.toContain("line3");
      expect(prompt).toContain("line4");
      expect(prompt).toContain("line5");
    });

    it("should apply start/end range slicing", async () => {
      mockReadFile.mockResolvedValue("line1\nline2\nline3\nline4\nline5\n");

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              files: [{ path: "src/foo.ts", start: 2, end: 4 }],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).not.toContain("line1");
      expect(prompt).toContain("line2");
      expect(prompt).toContain("line3");
      expect(prompt).toContain("line4");
      expect(prompt).not.toContain("line5");
    });

    it("should handle multiple files", async () => {
      mockReadFile.mockResolvedValueOnce("content-a\n").mockResolvedValueOnce("content-b\n");

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              files: ["a.ts", "b.ts"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("=== a.ts ===");
      expect(prompt).toContain("=== b.ts ===");
      expect(prompt).toContain("content-a");
      expect(prompt).toContain("content-b");
    });

    it("should work without files parameter (backward compatibility)", async () => {
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "do the thing" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toBe("do the thing");
    });

    it("should return placeholder for files exceeding size limit", async () => {
      mockStat.mockResolvedValue({ size: 2 * 1024 * 1024 }); // 2MB
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "large-file-task",
              prompt: "review",
              files: ["huge.log"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: "/project" } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.task.prompt).toContain("[file too large: huge.log");
      expect(callArgs.task.prompt).toContain("review");
    });

    it("should use task.cwd for path resolution when set", async () => {
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              cwd: "/custom/dir",
              files: ["src/foo.ts"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      const statCalls = vi.mocked(mockStat).mock.calls.map((call) => call[0] as string);
      const hasCustomDir = statCalls.some((p) => p.includes("/custom/dir"));
      expect(hasCustomDir).toBe(true);
    });

    it("should prepend files before resume context", async () => {
      const previousSessionId = "prev-session";
      const previousSession: SubagentSessionData = {
        sessionId: previousSessionId,
        taskName: "prev-task",
        prompt: "prev prompt",
        cwd: "/tmp",
        status: "completed",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Previous result" }],
          } as unknown as Message,
        ],
        exitCode: 0,
        startedAt: Date.now(),
      };
      sessionStore.set(previousSessionId, { runs: [previousSession] });

      mockReadFile.mockResolvedValue("data contents\n");

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              resume: previousSessionId,
              files: ["data.ts"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;

      // Verify ordering: files come first, then resume context, then prompt
      const fileIdx = prompt.indexOf("=== data.ts ===");
      const resumeIdx = prompt.indexOf("Previously:");
      const promptIdx = prompt.indexOf("do the thing");
      expect(fileIdx).toBeLessThan(resumeIdx);
      expect(resumeIdx).toBeLessThan(promptIdx);
    });
  });

  // ── File Path Security Validation ───────────────────────────────

  describe("delegate_to_subagents - file path security", () => {
    it("should deny access to files outside cwd via absolute path", async () => {
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              files: ["/etc/passwd"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: "/safe/project" } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("[access denied: path outside project directory: /etc/passwd]");
      expect(prompt).not.toContain("sensitive data");
    });

    it("should deny access to files outside cwd via traversal", async () => {
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              files: ["../../etc/shadow"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: "/safe/project" } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("[access denied: path outside project directory");
      expect(prompt).not.toContain("sensitive data");
    });

    it("should allow access to files within cwd", async () => {
      mockReadFile.mockResolvedValue("safe content\n");

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              files: ["src/foo.ts"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: "/safe/project" } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("=== src/foo.ts ===");
      expect(prompt).toContain("safe content");
      expect(prompt).not.toContain("[access denied");
    });

    it("should deny path traversal that escapes the task.cwd", async () => {
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              cwd: "/safe/subdir",
              files: ["../../etc/passwd"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: "/safe/project" } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      // ../../etc/passwd resolves to /etc/passwd which is outside /safe/subdir
      expect(prompt).toContain("[access denied: path outside project directory");
      expect(prompt).not.toContain("sensitive data");
    });

    it("should deny readFileContents with ../../etc/passwd path traversal via default cwd", async () => {
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            {
              name: "test-task",
              prompt: "do the thing",
              files: ["../../etc/passwd"],
            },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: "/home/user/project" } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      const prompt = callArgs.task.prompt;
      // ../../etc/passwd resolves to /etc/passwd which is outside /home/user/project
      expect(prompt).toContain("[access denied: path outside project directory");
      expect(prompt).not.toContain("sensitive data");
    });
  });
});
