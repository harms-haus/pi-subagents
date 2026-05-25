import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadExtendTimeoutDebounce } from "../settings";
import { runSubAgent } from "../spawner";
import { registerDelegateTool } from "../tools/delegate";
import { registerRetrievalTools } from "../tools/retrieval";
import type { SessionRecord, SubagentSessionData, WindowedSubagentDetails } from "../types";
import { CUSTOM_ENTRY_TYPE } from "../types";
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

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue("file content here\n"),
  statSync: vi.fn().mockReturnValue({ size: 100 }),
}));

describe("delegate-advanced", () => {
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

    const executeFn = toolRegistration?.[0].execute;
    if (!executeFn) {
      throw new Error("Tool not registered");
    }
    return executeFn;
  };

  beforeEach(() => {
    sessionStore = new Map();
    mockPi = createMockPi();
    vi.mocked(runSubAgent).mockClear();
    vi.mocked(runSubAgent).mockResolvedValue({ loopDetected: false });
  });

  // ── Timeout ─────────────────────────────────────────────────────

  describe("delegate_to_subagents - timeout", () => {
    it("should pass timeout parameter to runSubAgent via AbortSignal", async () => {
      const executeFn = getDelegateExecute();

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

      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.win.timeout).toBe(1);
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("should use DEFAULT_TIMEOUT when no timeout specified", async () => {
      const executeFn = getDelegateExecute();

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

      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
      expect(callArgs.win.timeout).toBe(600);
    });
  });

  // ── Timeout Detection ───────────────────────────────────────────

  describe("delegate_to_subagents - timeout detection", () => {
    it("should set error with 'Timed out' message when task exceeds its timeout", async () => {
      vi.useFakeTimers();

      vi.mocked(loadExtendTimeoutDebounce).mockResolvedValueOnce(1);

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

      const executeFn = getDelegateExecute();

      const executePromise = executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(1500);

      const result = await executePromise;

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("error");
      expect(text).toContain("Timed out");
      expect(text).toMatch(/after \d+s/);

      const details = result.details as WindowedSubagentDetails;
      expect(details.windows[0]!.status).toBe("error");
      expect(details.windows[0]!.errorMessage).toContain("Timed out");
      expect(details.windows[0]!.errorMessage).toMatch(/after \d+s/);

      vi.useRealTimers();
    });
  });

  // ── Timeout Extension ───────────────────────────────────────────

  describe("delegate_to_subagents - timeout extension", () => {
    it("should not extend timeout when subagent completes before timeout", async () => {
      vi.useFakeTimers();

      try {
        vi.mocked(runSubAgent).mockResolvedValueOnce({ loopDetected: false });

        const executeFn = getDelegateExecute();

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        await vi.advanceTimersByTimeAsync(500);

        const result = await executePromise;

        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0]!.status).not.toBe("error");
        expect(details.windows[0]!.errorMessage).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should extend timeout when subagent is active after original timeout", async () => {
      vi.useFakeTimers();

      try {
        vi.mocked(loadExtendTimeoutDebounce).mockResolvedValueOnce(2);

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

        const executeFn = getDelegateExecute();

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        await vi.advanceTimersByTimeAsync(1500);
        await vi.advanceTimersByTimeAsync(2500);

        const result = await executePromise;

        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0]!.status).toBe("error");
        expect(details.windows[0]!.errorMessage).toContain("Timed out");
        expect(details.windows[0]!.errorMessage).toMatch(/after \d+s/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should keep original timeout value in win.timeout for display", async () => {
      const executeFn = getDelegateExecute();

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
      expect(details.windows[0]!.timeout).toBe(1);
    });

    it("should abort when no activity after original timeout", async () => {
      vi.useFakeTimers();

      try {
        vi.mocked(loadExtendTimeoutDebounce).mockResolvedValueOnce(2);

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

        const executeFn = getDelegateExecute();

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);

        const result = await executePromise;

        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0]!.status).toBe("error");
        expect(details.windows[0]!.errorMessage).toContain("Timed out");
        expect(details.windows[0]!.errorMessage).toMatch(/after \d+s/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should abort immediately when extendDebounce is 0", async () => {
      vi.useFakeTimers();

      try {
        vi.mocked(loadExtendTimeoutDebounce).mockResolvedValueOnce(0);

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

        const executeFn = getDelegateExecute();

        const executePromise = executeFn(
          "tool-call-id",
          {
            tasks: [{ name: "test-task", prompt: "test prompt", timeout: 1 }],
          },
          undefined,
          vi.fn(),
          { cwd: process.cwd() } as any,
        );

        await vi.advanceTimersByTimeAsync(1100);

        const result = await executePromise;
        const details = result.details as WindowedSubagentDetails;
        expect(details.windows[0]!.status).toBe("error");
        expect(details.windows[0]!.errorMessage).toContain("Timed out");
        expect(details.windows[0]!.errorMessage).toMatch(/after \d+s/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Resume ──────────────────────────────────────────────────────

  describe("delegate_to_subagents - resume", () => {
    it("should reject resume with non-existent session ID", async () => {
      const executeFn = getDelegateExecute();

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
      const runningSessionId = "running-session-id";
      const mockRegisterSession = vi.fn();
      const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set([runningSessionId]));
      registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

      const toolRegistration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find((call: [{ name: string }]) => call[0].name === "delegate_to_subagents");
      const executeFn = toolRegistration?.[0].execute;
      if (!executeFn) throw new Error("Tool not registered");

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
      const executeFn = getDelegateExecute();

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

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "new instructions", resume: previousSessionId }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.task.prompt).toMatch(/^Previously:\n\n/);
      expect(callArgs.task.prompt).toContain("Previous assistant response");
      expect(callArgs.task.prompt).toContain("Instructions:\n\nnew instructions");
    });

    it("should reuse session ID for resumed task", async () => {
      const executeFn = getDelegateExecute();

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

      const result = await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "test-task", prompt: "new instructions", resume: previousSessionId }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect((result.details as Record<string, unknown>).sessionIds).toContain(previousSessionId);
    });
  });

  // ── Multi-run sessions ──────────────────────────────────────────

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
      if (!executeFn) throw new Error("Tool not registered");

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
      if (!executeFn) throw new Error("Tool not registered");

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
      if (!executeFn) throw new Error("Tool not registered");

      const result = await executeFn("tool-call-id", { sessionId }, undefined, vi.fn(), {
        cwd: process.cwd(),
      } as any);

      expect((result.details as any).runCount).toBe(2);
    });
  });

  // ── Abort Signal Forwarding ─────────────────────────────────────

  describe("delegate_to_subagents - abort signal forwarding", () => {
    it("should forward parent AbortSignal to per-task AbortController", async () => {
      const executeFn = getDelegateExecute();

      const parentAbortController = new AbortController();
      const capturedSignals: AbortSignal[] = [];

      vi.mocked(runSubAgent).mockImplementation(async (opts) => {
        capturedSignals.push(opts.signal!);
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

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(capturedSignals.length).toBe(2);

      expect(capturedSignals[0]!.aborted).toBe(false);
      expect(capturedSignals[1]!.aborted).toBe(false);

      parentAbortController.abort();

      await executePromise;

      expect(capturedSignals[0]!.aborted).toBe(true);
      expect(capturedSignals[1]!.aborted).toBe(true);
    });
  });

  // ── Error Messages in Summary ───────────────────────────────────

  describe("delegate_to_subagents - error message in summary", () => {
    it("should include error indicator and errorMessage in summary line", async () => {
      const executeFn = getDelegateExecute();

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

      expect(summaryText).toContain("✓ good-task: completed");
      expect(summaryText).toContain("✗ failing-task: error");
      expect(summaryText).toContain("test error");
    });
  });

  // ── Loop Detection ──────────────────────────────────────────────

  describe("delegate_to_subagents - loop detection", () => {
    it("should kill subagent immediately on loop detection", async () => {
      const executeFn = getDelegateExecute();

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
      expect(details.windows[0]!.status).toBe("error");
      expect(details.windows[0]!.errorMessage).toContain("Loop detected");
      expect(details.windows[0]!.exitCode).toBe(1);
    });

    it("should pass loop detection settings to runSubAgent", async () => {
      const { loadLoopingToolCount } = await import("../settings");
      vi.mocked(loadLoopingToolCount).mockResolvedValueOnce(3);

      const executeFn = getDelegateExecute();

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
      const callArgs = vi.mocked(runSubAgent).mock.calls[0]![0];
      expect(callArgs.loopingToolCount).toBe(3);
    });
  });

  // ── Persistence ─────────────────────────────────────────────────

  describe("persistence", () => {
    it("should call pi.appendEntry after successful task completion", async () => {
      vi.mocked(runSubAgent).mockImplementationOnce(async (opts) => {
        opts.win.status = "completed";
        opts.session.status = "completed";
        opts.win.exitCode = 0;
        opts.session.exitCode = 0;
        return { loopDetected: false };
      });

      const executeFn = getDelegateExecute();

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
      expect(mockPi.appendEntry).toHaveBeenCalledTimes(1);

      const [entryType, entryData] = vi.mocked(mockPi.appendEntry).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(entryType).toBe(CUSTOM_ENTRY_TYPE);
      expect(entryData.sessionId).toBe((result.details as WindowedSubagentDetails).sessionIds[0]);
      expect(entryData.taskName).toBe("test-task");
      expect(entryData.status).toBe("completed");
    });

    it("should call pi.appendEntry after unknown profile error", async () => {
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "profile-task", prompt: "test prompt", profile: "nonexistent-profile" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(mockPi.appendEntry).toHaveBeenCalledTimes(1);

      const [entryType, entryData] = vi.mocked(mockPi.appendEntry).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(entryType).toBe(CUSTOM_ENTRY_TYPE);
      expect(entryData.status).toBe("error");
      expect(entryData.errorMessage).toContain("Unknown profile");
      expect(entryData.errorMessage).toContain("nonexistent-profile");
    });

    it("should call pi.appendEntry after loop detection", async () => {
      vi.mocked(runSubAgent).mockResolvedValueOnce({ loopDetected: true });

      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [{ name: "loop-task", prompt: "test prompt" }],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(mockPi.appendEntry).toHaveBeenCalledTimes(1);

      const [entryType, entryData] = vi.mocked(mockPi.appendEntry).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(entryType).toBe(CUSTOM_ENTRY_TYPE);
      expect(entryData.status).toBe("error");
      expect(entryData.errorMessage).toContain("Loop detected");
    });

    it("should call pi.appendEntry once per task for multiple tasks", async () => {
      const executeFn = getDelegateExecute();

      await executeFn(
        "tool-call-id",
        {
          tasks: [
            { name: "task-1", prompt: "prompt 1" },
            { name: "task-2", prompt: "prompt 2" },
            { name: "task-3", prompt: "prompt 3" },
          ],
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd() } as any,
      );

      expect(mockPi.appendEntry).toHaveBeenCalledTimes(3);

      // Verify each call has the correct taskName
      const calls = vi.mocked(mockPi.appendEntry).mock.calls;
      const taskNames = calls.map((call) => (call[1] as Record<string, unknown>).taskName);
      expect(taskNames).toContain("task-1");
      expect(taskNames).toContain("task-2");
      expect(taskNames).toContain("task-3");

      // Each call should have a matching sessionId
      for (const call of calls) {
        const entryData = call[1] as Record<string, unknown>;
        const sessionId = entryData.sessionId as string;
        expect(typeof sessionId).toBe("string");
        expect(sessionId.length).toBeGreaterThan(0);
      }
    });

    it("should not throw if appendEntry fails", async () => {
      vi.mocked(runSubAgent).mockImplementationOnce(async (opts) => {
        opts.win.status = "completed";
        opts.session.status = "completed";
        opts.win.exitCode = 0;
        opts.session.exitCode = 0;
        return { loopDetected: false };
      });

      vi.mocked(mockPi.appendEntry).mockImplementation(() => {
        throw new Error("Storage is full");
      });

      const executeFn = getDelegateExecute();

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
      expect(result.content).toBeDefined();
      const details = result.details as WindowedSubagentDetails;
      expect(details.windows[0]!.status).toBe("completed");
    });
  });
});
