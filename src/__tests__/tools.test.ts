import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerProfileCommand } from "../commands/profile";
import { resolveProfile, resolveProfileSkills, validateProfileSkills } from "../profiles";
import { loadExtendTimeoutDebounce } from "../settings";
import { runSubAgent } from "../spawner";
import { registerDelegateTool } from "../tools/delegate";
import { registerRetrievalTools } from "../tools/retrieval";
import type { SessionRecord, SubagentSessionData, WindowedSubagentDetails } from "../types";
import { createMockPi, createMockTheme } from "./helpers";

// Mock the TUI components
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
    Union: vi.fn(() => ({})),
  },
}));

// Mock the spawner
vi.mock("../spawner", () => ({
  runSubAgent: vi.fn().mockResolvedValue({ loopDetected: false }),
}));

// Mock the profiles module
vi.mock("../profiles", () => ({
  loadProfiles: vi.fn().mockResolvedValue({}),
  resolveProfile: vi.fn(),
  profileSummary: vi.fn().mockReturnValue("profile-summary"),
  resolveProfileSkills: vi.fn((profile: unknown) => profile),
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

const { mockExistsSync, mockReadFileSync, mockStatSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockReadFileSync: vi.fn().mockReturnValue("file content here\n"),
  mockStatSync: vi.fn().mockReturnValue({ size: 100 }),
}));
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
}));

describe("tools", () => {
  describe("tool registration", () => {
    let mockPi: ExtensionAPI;
    let sessionStore: Map<string, SessionRecord>;
    let mockRegisterSession: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      sessionStore = new Map();
      mockRegisterSession = vi.fn();

      mockPi = createMockPi();
    });

    describe("registerRetrievalTools", () => {
      it("should register get_subagent_output tool", () => {
        registerRetrievalTools(mockPi, sessionStore);

        expect(mockPi.registerTool).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "get_subagent_output",
          }),
        );
      });

      it("should register get_subagent_session tool", () => {
        registerRetrievalTools(mockPi, sessionStore);

        expect(mockPi.registerTool).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "get_subagent_session",
          }),
        );
      });

      it("should register list_subagent_profiles tool", () => {
        registerRetrievalTools(mockPi, sessionStore);

        expect(mockPi.registerTool).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "list_subagent_profiles",
          }),
        );
      });

      it("should register all three retrieval tools", () => {
        registerRetrievalTools(mockPi, sessionStore);

        expect(mockPi.registerTool).toHaveBeenCalledTimes(3);

        const toolNames = vi
          .mocked(mockPi.registerTool)
          .mock.calls.map((call: [{ name: string }]) => call[0].name);
        expect(toolNames).toContain("get_subagent_output");
        expect(toolNames).toContain("get_subagent_session");
        expect(toolNames).toContain("list_subagent_profiles");
      });
    });

    describe("registerDelegateTool", () => {
      it("should register delegate_to_subagents tool", () => {
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        expect(mockPi.registerTool).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "delegate_to_subagents",
          }),
        );
      });
    });

    describe("registerProfileCommand", () => {
      it("should register /profile command", () => {
        registerProfileCommand(mockPi);

        expect(mockPi.registerCommand).toHaveBeenCalledWith("profile", expect.any(Object));
      });
    });
  });

  describe("sessionStore operations", () => {
    let sessionStore: Map<string, SessionRecord>;
    let mockPi: ExtensionAPI;

    beforeEach(() => {
      sessionStore = new Map();
      mockPi = createMockPi();
      vi.mocked(runSubAgent).mockClear();
    });

    describe("get_subagent_output", () => {
      it("should return last assistant text for valid session", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        // Add a test session
        const testSession: SubagentSessionData = {
          sessionId: "test-session",
          taskName: "test-task",
          prompt: "test prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Final output from sub-agent" }],
            } as unknown as Message,
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set("test-session", { runs: [testSession] });

        // Get the tool execute function
        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }
        const result = await executeFn(
          "tool-call-id",
          { sessionId: "test-session" },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        expect(result.content[0].type).toBe("text");
        expect((result.content[0] as { text: string }).text).toBe("Final output from sub-agent");
        expect((result.details as Record<string, unknown>).sessionId).toBe("test-session");
      });

      it("should throw error for invalid session ID", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        await expect(
          executeFn("tool-call-id", { sessionId: "non-existent-session" }, undefined, vi.fn(), {
            cwd: process.cwd(),
          } as any),
        ).rejects.toThrow('Session "non-existent-session" not found');
      });

      it("should return placeholder when session has no text output", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const testSession: SubagentSessionData = {
          sessionId: "test-session",
          taskName: "test-task",
          prompt: "test prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set("test-session", { runs: [testSession] });

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output");
        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }
        const result = await executeFn(
          "tool-call-id",
          { sessionId: "test-session" },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        expect((result.content[0] as { text: string }).text).toBe(
          "(no text output from sub-agent)",
        );
      });
    });

    describe("get_subagent_session", () => {
      it("should return full session transcript for valid session", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const testSession: SubagentSessionData = {
          sessionId: "test-session",
          taskName: "test-task",
          prompt: "test prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "First response" },
                {
                  type: "toolCall",
                  name: "test-tool",
                  arguments: { arg1: "value1" },
                  id: "tool-call-1",
                },
              ],
            } as unknown as Message,
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set("test-session", { runs: [testSession] });

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_session");
        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }
        const result = await executeFn(
          "tool-call-id",
          { sessionId: "test-session" },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        expect(result.content[0].type).toBe("text");
        expect((result.content[0] as { text: string }).text).toContain("First response");
        expect((result.details as Record<string, unknown>).messageCount).toBe(1);
      });

      it("should throw error for invalid session ID", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_session");

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        await expect(
          executeFn("tool-call-id", { sessionId: "non-existent" }, undefined, vi.fn(), {
            cwd: process.cwd(),
          } as any),
        ).rejects.toThrow('Session "non-existent" not found');
      });
    });

    describe("renderCall functions", () => {
      it("should render get_subagent_output call with session ID", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output");
        const renderCall = toolRegistration?.[0].renderCall;
        if (!renderCall) {
          throw new Error("Tool not registered");
        }

        const mockTheme = createMockTheme();

        renderCall({ sessionId: "test-123" }, mockTheme, null as any);

        expect(mockTheme.fg).toHaveBeenCalledWith("accent", "test-123");
      });

      it("should render get_subagent_output call without session ID (placeholder)", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output");
        const renderCall = toolRegistration?.[0].renderCall;
        if (!renderCall) {
          throw new Error("Tool not registered");
        }

        const mockTheme = createMockTheme();

        renderCall({}, mockTheme, null as any);

        expect(mockTheme.fg).toHaveBeenCalledWith("accent", "...");
      });

      it("should render get_subagent_session call with session ID", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_session");
        const renderCall = toolRegistration?.[0].renderCall;
        if (!renderCall) {
          throw new Error("Tool not registered");
        }

        const mockTheme = createMockTheme();

        renderCall({ sessionId: "session-456" }, mockTheme, null as any);

        expect(mockTheme.fg).toHaveBeenCalledWith("accent", "session-456");
      });
    });

    describe("renderResult functions", () => {
      it("should render result with text content", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output");
        const renderResult = toolRegistration?.[0].renderResult;
        if (!renderResult) {
          throw new Error("Tool not registered");
        }

        const mockTheme = createMockTheme();

        const result = {
          content: [{ type: "text", text: "Test output content" }],
          details: {},
        };

        renderResult(result as any, { expanded: false, isPartial: false }, mockTheme, null as any);

        expect(mockTheme.fg).toHaveBeenCalledWith("toolOutput", "Test output content");
      });

      it("should render result with no text content (default label)", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output");
        const renderResult = toolRegistration?.[0].renderResult;
        if (!renderResult) {
          throw new Error("Tool not registered");
        }

        const mockTheme = createMockTheme();

        // When content is not text type, it should use default label
        const result = {
          content: [{} as { type: string }],
          details: {},
        };

        renderResult(result as any, { expanded: false, isPartial: false }, mockTheme, null as any);

        expect(mockTheme.fg).toHaveBeenCalledWith("toolOutput", "(no output)");
      });
    });

    describe("delegate_to_subagents - timeout", () => {
      it("should pass timeout parameter to runSubAgent via AbortSignal", async () => {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const result = await executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        expect(result).toBeDefined();
        expect(runSubAgent).toHaveBeenCalledTimes(1);

        // Verify the timeout value (1 second) was passed through to the window
        const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
        expect(callArgs.win.timeout).toBe(1);
        expect(callArgs.signal).toBeInstanceOf(AbortSignal);
      });

      it("should use DEFAULT_TIMEOUT when no timeout specified", async () => {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const result = await executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt" }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        expect(result).toBeDefined();
        expect(runSubAgent).toHaveBeenCalledTimes(1);

        // Verify a signal was passed and the default timeout value (600s) was used
        const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
        expect(callArgs.signal).toBeInstanceOf(AbortSignal);
        expect(callArgs.win.timeout).toBe(600);
      });
    });

    describe("delegate_to_subagents - excludeTools resolution", () => {
      it("should compute tools allowlist from excludeTools and getAllTools", async () => {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

        // Mock getAllTools to return a set of tools
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

        // Mock resolveProfile to return a profile with excludeTools
        vi.mocked(resolveProfile).mockReturnValue({
          excludeTools: ["bash"],
        });

        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        await executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", profile: "restricted" }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // Verify runSubAgent was called with the computed tools allowlist
        expect(runSubAgent).toHaveBeenCalledTimes(1);
        const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
        expect(callArgs.profile).toBeDefined();
        expect(callArgs.profile?.tools).toEqual(["read", "write"]);
        expect(callArgs.profile?.excludeTools).toBeUndefined();
      });

      it("should throw an error when profile has both tools and excludeTools", async () => {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

        // Mock resolveProfile to return a profile with both tools and excludeTools
        vi.mocked(resolveProfile).mockReturnValue({
          tools: ["read"],
          excludeTools: ["bash"],
        });

        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

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

    describe("delegate_to_subagents - unknown profile", () => {
      it("should set error status when profile name does not exist", async () => {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

        // resolveProfile returns undefined for unknown profiles
        vi.mocked(resolveProfile).mockReturnValue(undefined);
        // loadProfiles returns a known set that does NOT include "nonexistent"
        const { loadProfiles } = await import("../profiles");
        vi.mocked(loadProfiles).mockResolvedValueOnce({
          "code-reviewer": { model: "anthropic/claude-sonnet-4" },
          "fast-worker": { provider: "openai" },
        });

        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const result = await executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", profile: "nonexistent" }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // runSubAgent should NOT have been called for this task
        expect(runSubAgent).not.toHaveBeenCalled();

        // Result should show the error in the window
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("error");
        expect(text).toContain("Unknown profile");

        // Details should show the window in error status
        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0].status).toBe("error");
        expect(details.windows[0].errorMessage).toContain("Unknown profile");
        expect(details.windows[0].errorMessage).toContain("nonexistent");
      });
    });

    describe("delegate_to_subagents - timeout detection", () => {
      it("should set error with 'Timed out' message when task exceeds its timeout", async () => {
        vi.useFakeTimers();

        // Override debounce to a small value so the two-timer approach completes quickly
        vi.mocked(loadExtendTimeoutDebounce).mockResolvedValueOnce(1);

        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

        // Mock runSubAgent to wait until the abort signal fires, then resolve
        vi.mocked(runSubAgent).mockImplementationOnce(async (options) => {
          return new Promise<{ loopDetected: boolean }>((resolve) => {
            if (options.signal?.aborted) {
              resolve({ loopDetected: false });
              return;
            }
            const onAbort = () => {
              options.signal?.removeEventListener("abort", onAbort);
              resolve({ loopDetected: false });
            };
            options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        });

        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // Advance past the 1-second timeout (Timer 1 fires, starts idle timer)
        await vi.advanceTimersByTimeAsync(1500);
        // Advance past the 1-second idle timer (Timer 2 fires, aborts)
        await vi.advanceTimersByTimeAsync(1500);

        const result = await executePromise;

        // The result text should contain "Timed out"
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("error");
        expect(text).toContain("Timed out");
        expect(text).toMatch(/after \d+s/);

        // Window details should show the timeout error
        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0].status).toBe("error");
        expect(details.windows[0].errorMessage).toContain("Timed out");
        expect(details.windows[0].errorMessage).toMatch(/after \d+s/);

        vi.useRealTimers();
      });
    });

    describe("delegate_to_subagents - resume", () => {
      it("should reject resume with non-existent session ID", async () => {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        await expect(
          executeFn(
            "tool-call-id",
            {
              tasks: [{ name: "test-task", prompt: "test prompt", resume: "nonexistent" }],
            },
            undefined,
            vi.fn(),
            { cwd: process.cwd() } as any,
          ),
        ).rejects.toThrow(/not found/i);
      });

      it("should reject resume when session is still running", async () => {
        const mockRegisterSession = vi.fn();
        const runningSessionId = "running-session-id";
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set([runningSessionId]));
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        // Set up a session with running status
        const runningSession: SubagentSessionData = {
          sessionId: runningSessionId,
          taskName: "running-task",
          prompt: "running prompt",
          cwd: "/tmp",
          status: "running",
          messages: [],
          exitCode: null,
          startedAt: Date.now(),
        };
        sessionStore.set(runningSessionId, { runs: [runningSession] });

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        await expect(
          executeFn(
            "tool-call-id",
            {
              tasks: [{ name: "test-task", prompt: "test prompt", resume: runningSessionId }],
            },
            undefined,
            vi.fn(),
            { cwd: process.cwd() } as any,
          ),
        ).rejects.toThrow(/still running/i);
      });

      it("should format resume prompt with previous session data", async () => {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const previousSessionId = "previous-session-id";
        const previousSession: SubagentSessionData = {
          sessionId: previousSessionId,
          taskName: "previous-task",
          prompt: "previous prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Previous assistant response" }],
            } as unknown as Message,
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set(previousSessionId, { runs: [previousSession] });

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        await executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "new instructions", resume: previousSessionId }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // Verify the prompt passed to runSubAgent contains the resume formatting
        const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
        expect(callArgs.task.prompt).toMatch(/^Previously:\n\n/);
        expect(callArgs.task.prompt).toContain("Previous assistant response");
        expect(callArgs.task.prompt).toContain("Instructions:\n\nnew instructions");
      });

      it("should reuse session ID for resumed task", async () => {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const previousSessionId = "known-session-id";
        const previousSession: SubagentSessionData = {
          sessionId: previousSessionId,
          taskName: "previous-task",
          prompt: "previous prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set(previousSessionId, { runs: [previousSession] });

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const result = await executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "new instructions", resume: previousSessionId }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // Verify the session ID in the result matches the original
        expect((result.details as Record<string, unknown>).sessionIds).toContain(previousSessionId);
      });
    });

    describe("get_subagent_output - multi-run", () => {
      it("should return latest run output for multi-run session", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const sessionId = "multi-run-session";
        const firstRun: SubagentSessionData = {
          sessionId,
          taskName: "first-task",
          prompt: "first prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "First run output" }],
            } as unknown as Message,
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        const secondRun: SubagentSessionData = {
          sessionId,
          taskName: "second-task",
          prompt: "second prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Second run output" }],
            } as unknown as Message,
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set(sessionId, { runs: [firstRun, secondRun] });

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output");
        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const result = await executeFn("tool-call-id", { sessionId }, undefined, vi.fn(), {
          cwd: process.cwd(),
        } as any);

        expect((result.content[0] as { text: string }).text).toBe("Second run output");
      });
    });

    describe("get_subagent_session - multi-run", () => {
      it("should return all runs concatenated for multi-run session", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const sessionId = "multi-run-session";
        const firstRun: SubagentSessionData = {
          sessionId,
          taskName: "first-task",
          prompt: "first prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "First run message" }],
            } as unknown as Message,
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        const secondRun: SubagentSessionData = {
          sessionId,
          taskName: "second-task",
          prompt: "second prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Second run message" }],
            } as unknown as Message,
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set(sessionId, { runs: [firstRun, secondRun] });

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_session");
        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const result = await executeFn("tool-call-id", { sessionId }, undefined, vi.fn(), {
          cwd: process.cwd(),
        } as any);

        expect((result.content[0] as { text: string }).text).toContain("Run 1/2");
        expect((result.content[0] as { text: string }).text).toContain("Run 2/2");
        expect((result.content[0] as { text: string }).text).toContain("First run message");
        expect((result.content[0] as { text: string }).text).toContain("Second run message");
      });

      it("should include runCount in details", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const sessionId = "multi-run-session";
        const firstRun: SubagentSessionData = {
          sessionId,
          taskName: "first-task",
          prompt: "first prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [],
          exitCode: 0,
          startedAt: Date.now(),
        };
        const secondRun: SubagentSessionData = {
          sessionId,
          taskName: "second-task",
          prompt: "second prompt",
          cwd: "/tmp",
          status: "completed",
          messages: [],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set(sessionId, { runs: [firstRun, secondRun] });

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_session");
        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const result = await executeFn("tool-call-id", { sessionId }, undefined, vi.fn(), {
          cwd: process.cwd(),
        } as any);

        expect((result.details as any).runCount).toBe(2);
      });
    });
  });

  describe("delegate_to_subagents - abort signal forwarding", () => {
    let mockPi: ExtensionAPI;
    let sessionStore: Map<string, SessionRecord>;

    beforeEach(() => {
      sessionStore = new Map();
      mockPi = createMockPi();
      vi.mocked(runSubAgent).mockClear();
    });

    it("should forward parent AbortSignal to per-task AbortController", async () => {
      const mockRegisterSession = vi.fn();
      const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
      registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

      const toolRegistration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
      const executeFn = toolRegistration?.[0].execute;
      if (!executeFn) {
        throw new Error("Tool not registered");
      }

      // Parent abort controller
      const parentAbortController = new AbortController();

      // Capture signals passed to runSubAgent
      const capturedSignals: AbortSignal[] = [];

      // Make runSubAgent return a pending promise so the task stays alive
      vi.mocked(runSubAgent).mockImplementation(async (opts) => {
        capturedSignals.push(opts.signal!);
        // Return a promise that stays pending until aborted
        return new Promise<{ loopDetected: boolean }>((resolve) => {
          if (opts.signal?.aborted) {
            resolve({ loopDetected: false });
            return;
          }
          opts.signal?.addEventListener(
            "abort",
            () => {
              resolve({ loopDetected: false });
            },
            {
              once: true,
            },
          );
        });
      });

      // Start execute with 2 tasks and a parent signal
      const executePromise = executeFn(
        "tool-call-id",
        {
          tasks: [
            { name: "task-1", prompt: "prompt 1" },
            { name: "task-2", prompt: "prompt 2" },
          ],
        },
        parentAbortController.signal,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      // Wait for runSubAgent to be called for both tasks
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(capturedSignals.length).toBe(2);

      // Neither per-task signal should be aborted yet
      expect(capturedSignals[0].aborted).toBe(false);
      expect(capturedSignals[1].aborted).toBe(false);

      // Abort the parent signal
      parentAbortController.abort();

      // Wait for the abort to propagate
      await executePromise;

      // Both per-task signals should now be aborted
      expect(capturedSignals[0].aborted).toBe(true);
      expect(capturedSignals[1].aborted).toBe(true);
    });
  });

  describe("delegate_to_subagents - error message in summary", () => {
    let mockPi: ExtensionAPI;
    let sessionStore: Map<string, SessionRecord>;

    beforeEach(() => {
      sessionStore = new Map();
      mockPi = createMockPi();
      vi.mocked(runSubAgent).mockClear();
    });

    it("should include error indicator and errorMessage in summary line", async () => {
      const mockRegisterSession = vi.fn();
      const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
      registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

      const toolRegistration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
      const executeFn = toolRegistration?.[0].execute;
      if (!executeFn) {
        throw new Error("Tool not registered");
      }

      // Mock runSubAgent to set win.status = "error" and win.errorMessage on the second task
      vi.mocked(runSubAgent).mockImplementation(async (opts) => {
        if (opts.task.name === "failing-task") {
          opts.win.status = "error";
          opts.win.errorMessage = "test error";
          opts.win.exitCode = 1;
          opts.session.status = "error";
          opts.session.errorMessage = "test error";
          opts.session.exitCode = 1;
        } else {
          opts.win.status = "completed";
          opts.win.exitCode = 0;
          opts.session.status = "completed";
          opts.session.exitCode = 0;
        }
        return { loopDetected: false };
      });

      const result = await executeFn(
        "tool-call-id",
        {
          tasks: [
            { name: "good-task", prompt: "prompt 1" },
            { name: "failing-task", prompt: "prompt 2" },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      const summaryText = (result.content[0] as { text: string }).text;

      // Good task should have ✓ indicator
      expect(summaryText).toContain("✓ good-task: completed");
      // Failing task should have ✗ indicator and error message
      expect(summaryText).toContain("✗ failing-task: error");
      expect(summaryText).toContain("test error");
    });
  });

  describe("delegate_to_subagents - skill resolution", () => {
    let mockPi: ExtensionAPI;
    let sessionStore: Map<string, SessionRecord>;

    beforeEach(() => {
      sessionStore = new Map();
      mockPi = createMockPi();
      vi.mocked(runSubAgent).mockClear();
      vi.mocked(runSubAgent).mockResolvedValue({ loopDetected: false });
      // Reset skill mocks to defaults and clear call history
      vi.mocked(resolveProfileSkills).mockClear();
      vi.mocked(resolveProfileSkills).mockImplementation(
        (profile: unknown) => profile as Record<string, unknown>,
      );
      vi.mocked(validateProfileSkills).mockClear();
      vi.mocked(validateProfileSkills).mockImplementation(() => {});
    });

    const getDelegateExecute = async () => {
      const mockRegisterSession = vi.fn();
      const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
      registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

      const toolRegistration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
      expect(toolRegistration).toBeDefined();

      const executeFn = toolRegistration?.[0].execute;
      if (!executeFn) {
        throw new Error("Tool not registered");
      }
      return executeFn;
    };

    it("should pass resolved skill paths to runSubAgent via profile", async () => {
      vi.mocked(resolveProfile).mockReturnValue({
        suggestedSkills: ["my-skill"],
      });

      vi.mocked(resolveProfileSkills).mockImplementation((profile: unknown) => {
        const p = profile as Record<string, unknown>;
        return {
          ...p,
          suggestedSkills: ["/skills/my-skill/SKILL.md"],
        };
      });

      const executeFn = await getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "skill-task", prompt: "do work", profile: "skilled" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      // resolveProfileSkills should have been called
      expect(resolveProfileSkills).toHaveBeenCalledTimes(1);
      expect(resolveProfileSkills).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedSkills: ["my-skill"] }),
        process.cwd(),
        expect.any(Map),
      );

      // runSubAgent should have been called with the resolved profile containing skill paths
      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      expect(callArgs.profile).toBeDefined();
      expect(callArgs.profile!.suggestedSkills).toEqual(["/skills/my-skill/SKILL.md"]);
    });

    it("should set error status when skill name is not found", async () => {
      vi.mocked(resolveProfile).mockReturnValue({
        suggestedSkills: ["missing-skill"],
      });

      vi.mocked(resolveProfileSkills).mockImplementation(() => {
        throw new Error('Skill "missing-skill" not found');
      });

      const executeFn = await getDelegateExecute();

      const result = await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "bad-skill-task", prompt: "do work", profile: "skilled" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      // runSubAgent should NOT have been called
      expect(runSubAgent).not.toHaveBeenCalled();

      // Window should show error with the skill error message
      const details = result.details as WindowedSubagentDetails;
      expect(details.windows[0].status).toBe("error");
      expect(details.windows[0].errorMessage).toContain('Skill "missing-skill" not found');

      // Summary text should reflect the error
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("error");
      expect(text).toContain('Skill "missing-skill" not found');
    });

    it("should not call resolveProfileSkills when profile has no skills", async () => {
      vi.mocked(resolveProfile).mockReturnValue({
        model: "anthropic/claude-sonnet-4",
      });

      const executeFn = await getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "plain-task", prompt: "do work", profile: "plain" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      // resolveProfileSkills should NOT have been called since profile has no skills
      expect(resolveProfileSkills).not.toHaveBeenCalled();

      // runSubAgent should still have been called with the plain profile
      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
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

      const executeFn = await getDelegateExecute();

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

      // runSubAgent should not have been called
      expect(runSubAgent).not.toHaveBeenCalled();
    });

    it("should resolve skills independently per task", async () => {
      vi.mocked(resolveProfile)
        .mockReturnValueOnce({ suggestedSkills: ["skill-a"] })
        .mockReturnValueOnce({ suggestedSkills: ["skill-b"] });

      vi.mocked(resolveProfileSkills)
        .mockImplementationOnce((profile: unknown) => ({
          ...(profile as Record<string, unknown>),
          suggestedSkills: ["/a/SKILL.md"],
        }))
        .mockImplementationOnce((profile: unknown) => ({
          ...(profile as Record<string, unknown>),
          suggestedSkills: ["/b/SKILL.md"],
        }));

      const executeFn = await getDelegateExecute();

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

      // resolveProfileSkills should have been called twice, once per task
      expect(resolveProfileSkills).toHaveBeenCalledTimes(2);

      // Each call should receive the correct profile
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

      // runSubAgent should have been called twice
      expect(runSubAgent).toHaveBeenCalledTimes(2);

      // Each call should get its own resolved profile
      const call0 = vi.mocked(runSubAgent).mock.calls[0][0];
      expect(call0.profile!.suggestedSkills).toEqual(["/a/SKILL.md"]);

      const call1 = vi.mocked(runSubAgent).mock.calls[1][0];
      expect(call1.profile!.suggestedSkills).toEqual(["/b/SKILL.md"]);
    });

    it("should allow other tasks to continue when one task's skill resolution fails", async () => {
      vi.mocked(resolveProfile)
        .mockReturnValueOnce({ suggestedSkills: ["bad-skill"] })
        .mockReturnValueOnce({ suggestedSkills: ["good-skill"] });

      vi.mocked(resolveProfileSkills)
        .mockImplementationOnce(() => {
          throw new Error('Skill "bad-skill" not found');
        })
        .mockImplementationOnce((profile: unknown) => ({
          ...(profile as Record<string, unknown>),
          suggestedSkills: ["/good/SKILL.md"],
        }));

      const executeFn = await getDelegateExecute();

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

      // runSubAgent should have been called only for the succeeding task
      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      expect(callArgs.task.name).toBe("succeeding-task");
      expect(callArgs.profile!.suggestedSkills).toEqual(["/good/SKILL.md"]);

      // Result should show one error and one (pending/completed) window
      const details = result.details as WindowedSubagentDetails;
      const failWindow = details.windows.find((w) => w.name === "failing-task");
      const successWindow = details.windows.find((w) => w.name === "succeeding-task");

      expect(failWindow?.status).toBe("error");
      expect(failWindow?.errorMessage).toContain('Skill "bad-skill" not found');
      // The succeeding task's window should not be in error
      expect(successWindow?.status).not.toBe("error");
    });
  });

  describe("delegate_to_subagents - timeout extension", () => {
    let mockPi: ExtensionAPI;
    let sessionStore: Map<string, SessionRecord>;

    beforeEach(() => {
      sessionStore = new Map();
      mockPi = createMockPi();
      vi.mocked(runSubAgent).mockClear();
    });

    it("should not extend timeout when subagent completes before timeout", async () => {
      vi.useFakeTimers();

      try {
        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        // runSubAgent resolves immediately (subagent finishes well before timeout)
        vi.mocked(runSubAgent).mockResolvedValueOnce({ loopDetected: false });

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // Advance a small amount (500ms) — subagent already resolved
        await vi.advanceTimersByTimeAsync(500);

        const result = await executePromise;

        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0].status).not.toBe("error");
        expect(details.windows[0].errorMessage).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should extend timeout when subagent is active after original timeout", async () => {
      vi.useFakeTimers();

      try {
        // Override debounce to 2 seconds
        vi.mocked(loadExtendTimeoutDebounce).mockResolvedValueOnce(2);

        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

        // Mock runSubAgent to wait until the abort signal fires, then resolve
        vi.mocked(runSubAgent).mockImplementationOnce(async (options) => {
          return new Promise<{ loopDetected: boolean }>((resolve) => {
            if (options.signal?.aborted) {
              resolve({ loopDetected: false });
              return;
            }
            const onAbort = () => {
              options.signal?.removeEventListener("abort", onAbort);
              resolve({ loopDetected: false });
            };
            options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        });

        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // Advance to 1s: original timeout fires, starts idle timer (2s)
        await vi.advanceTimersByTimeAsync(1500);
        // Advance past the 2-second idle timer: idle timer fires, aborts
        await vi.advanceTimersByTimeAsync(2500);

        const result = await executePromise;

        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0].status).toBe("error");
        expect(details.windows[0].errorMessage).toContain("Timed out");
        expect(details.windows[0].errorMessage).toMatch(/after \d+s/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should keep original timeout value in win.timeout for display", async () => {
      const mockRegisterSession = vi.fn();
      const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
      registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

      const toolRegistration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
      expect(toolRegistration).toBeDefined();

      const executeFn = toolRegistration?.[0].execute;
      if (!executeFn) {
        throw new Error("Tool not registered");
      }

      const result = await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      const details = result.details as WindowedSubagentDetails;
      expect(details.windows[0].timeout).toBe(1);
    });

    it("should abort when no activity after original timeout", async () => {
      vi.useFakeTimers();

      try {
        // Override debounce to 2 seconds
        vi.mocked(loadExtendTimeoutDebounce).mockResolvedValueOnce(2);

        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

        // Mock runSubAgent to wait until the abort signal fires (no activity)
        vi.mocked(runSubAgent).mockImplementationOnce(async (options) => {
          return new Promise<{ loopDetected: boolean }>((resolve) => {
            if (options.signal?.aborted) {
              resolve({ loopDetected: false });
              return;
            }
            const onAbort = () => {
              options.signal?.removeEventListener("abort", onAbort);
              resolve({ loopDetected: false });
            };
            options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        });

        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // Advance to 1s: original timeout fires, starts idle timer (2s)
        await vi.advanceTimersByTimeAsync(1000);
        // Advance to 3s total (1s + 2s): idle timer fires, aborts
        await vi.advanceTimersByTimeAsync(2000);

        const result = await executePromise;

        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0].status).toBe("error");
        expect(details.windows[0].errorMessage).toContain("Timed out");
        expect(details.windows[0].errorMessage).toMatch(/after \d+s/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should abort immediately when extendDebounce is 0", async () => {
      vi.useFakeTimers();

      try {
        vi.mocked(loadExtendTimeoutDebounce).mockResolvedValueOnce(0);

        const mockRegisterSession = vi.fn();
        const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

        vi.mocked(runSubAgent).mockImplementationOnce(async (options) => {
          return new Promise<{ loopDetected: boolean }>((resolve) => {
            if (options.signal?.aborted) {
              resolve({ loopDetected: false });
              return;
            }
            const onAbort = () => {
              options.signal?.removeEventListener("abort", onAbort);
              resolve({ loopDetected: false });
            };
            options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        });

        registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        // Advance past the 1-second timeout
        await vi.advanceTimersByTimeAsync(1100);

        const result = await executePromise;
        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0].status).toBe("error");
        expect(details.windows[0].errorMessage).toContain("Timed out");
        expect(details.windows[0].errorMessage).toMatch(/after \d+s/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("delegate_to_subagents - loop detection", () => {
    let mockPi: ExtensionAPI;
    let sessionStore: Map<string, SessionRecord>;

    beforeEach(() => {
      sessionStore = new Map();
      mockPi = createMockPi();
      vi.mocked(runSubAgent).mockClear();
    });

    it("should kill subagent immediately on loop detection", async () => {
      const mockRegisterSession = vi.fn();
      const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
      registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

      const toolRegistration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
      expect(toolRegistration).toBeDefined();

      const executeFn = toolRegistration?.[0].execute;
      if (!executeFn) {
        throw new Error("Tool not registered");
      }

      // Mock runSubAgent to resolve with loop detected
      vi.mocked(runSubAgent).mockResolvedValueOnce({ loopDetected: true });

      const result = await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "test prompt" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      const details = result.details as WindowedSubagentDetails;
      expect(details.windows[0].status).toBe("error");
      expect(details.windows[0].errorMessage).toContain("Loop detected");
      expect(details.windows[0].exitCode).toBe(1);
    });

    it("should pass loop detection settings to runSubAgent", async () => {
      const mockRegisterSession = vi.fn();
      const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());

      // Override settings mocks
      const { loadLoopingToolCount } = await import("../settings");
      vi.mocked(loadLoopingToolCount).mockResolvedValueOnce(3);

      registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

      const toolRegistration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
      expect(toolRegistration).toBeDefined();

      const executeFn = toolRegistration?.[0].execute;
      if (!executeFn) {
        throw new Error("Tool not registered");
      }

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "test prompt" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(runSubAgent).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      expect(callArgs.loopingToolCount).toBe(3);
      // loopingToolCount is passed through to runSubAgent
      expect(callArgs.loopingToolCount).toBe(3);
    });
  });

  describe("delegate_to_subagents - files parameter", () => {
    let mockPi: ExtensionAPI;
    let sessionStore: Map<string, SessionRecord>;

    const getDelegateExecute = async () => {
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
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("file content here\n");
      mockStatSync.mockReturnValue({ size: 100 });
    });

    it("should prepend file contents before the prompt", async () => {
      mockReadFileSync.mockReturnValue("hello world\n");

      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("=== src/foo.ts ===");
      expect(prompt).toContain("hello world");
      const fileIdx = prompt.indexOf("=== src/foo.ts ===");
      const promptIdx = prompt.indexOf("do the thing");
      expect(fileIdx).toBeLessThan(promptIdx);
    });

    it("should handle missing files with placeholder", async () => {
      mockExistsSync.mockReturnValue(false);

      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("[file not found: missing.ts]");
    });

    it("should handle read errors with placeholder", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("permission denied");
      });

      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("[could not read file: no-access.ts]");
    });

    it("should apply head slicing", async () => {
      mockReadFileSync.mockReturnValue("line1\nline2\nline3\nline4\nline5\n");

      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("line1");
      expect(prompt).toContain("line2");
      expect(prompt).not.toContain("line3");
    });

    it("should apply tail slicing", async () => {
      mockReadFileSync.mockReturnValue("line1\nline2\nline3\nline4\nline5\n");

      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;
      expect(prompt).not.toContain("line3");
      expect(prompt).toContain("line4");
      expect(prompt).toContain("line5");
    });

    it("should apply start/end range slicing", async () => {
      mockReadFileSync.mockReturnValue("line1\nline2\nline3\nline4\nline5\n");

      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;
      expect(prompt).not.toContain("line1");
      expect(prompt).toContain("line2");
      expect(prompt).toContain("line3");
      expect(prompt).toContain("line4");
      expect(prompt).not.toContain("line5");
    });

    it("should handle multiple files", async () => {
      mockReadFileSync.mockReturnValueOnce("content-a\n").mockReturnValueOnce("content-b\n");

      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toContain("=== a.ts ===");
      expect(prompt).toContain("=== b.ts ===");
      expect(prompt).toContain("content-a");
      expect(prompt).toContain("content-b");
    });

    it("should work without files parameter (backward compatibility)", async () => {
      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;
      expect(prompt).toBe("do the thing");
    });

    it("should return placeholder for files exceeding size limit", async () => {
      mockStatSync.mockReturnValue({ size: 2 * 1024 * 1024 }); // 2MB
      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      expect(callArgs.task.prompt).toContain("[file too large: huge.log");
      expect(callArgs.task.prompt).toContain("review");
    });

    it("should use task.cwd for path resolution when set", async () => {
      const executeFn = await getDelegateExecute();

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

      expect(mockExistsSync).toHaveBeenCalled();
      const existsCalls = vi.mocked(mockExistsSync).mock.calls.map((call) => call[0] as string);
      const hasCustomDir = existsCalls.some((p) => p.includes("/custom/dir"));
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

      mockReadFileSync.mockReturnValue("data contents\n");

      const executeFn = await getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0][0];
      const prompt = callArgs.task.prompt;

      // Verify ordering: files come first, then resume context, then prompt
      const fileIdx = prompt.indexOf("=== data.ts ===");
      const resumeIdx = prompt.indexOf("Previously:");
      const promptIdx = prompt.indexOf("do the thing");
      expect(fileIdx).toBeLessThan(resumeIdx);
      expect(resumeIdx).toBeLessThan(promptIdx);
    });
  });
});
