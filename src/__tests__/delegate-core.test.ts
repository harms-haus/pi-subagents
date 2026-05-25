import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerProfileCommand } from "../commands/profile";
import { runSubAgent } from "../spawner";
import { registerDelegateTool } from "../tools/delegate";
import { registerRetrievalTools } from "../tools/retrieval";
import type { SessionRecord, SubagentSessionData } from "../types";
import { createMockPi, createMockTheme } from "./helpers";

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

describe("delegate-core", () => {
  let mockPi: ExtensionAPI;
  let sessionStore: Map<string, SessionRecord>;

  beforeEach(() => {
    sessionStore = new Map();
    mockPi = createMockPi();
  });

  // ── Tool Registration ──────────────────────────────────────────

  describe("registerRetrievalTools", () => {
    it("should register all three retrieval tools with correct names", () => {
      registerRetrievalTools(mockPi, sessionStore);

      expect(mockPi.registerTool).toHaveBeenCalledTimes(3);

      const toolNames = vi
        .mocked(mockPi.registerTool)
        .mock.calls.map((call: [{ name: string }]) => call[0].name);
      expect(toolNames).toContain("get_subagent_output");
      expect(toolNames).toContain("get_subagent_session");
      expect(toolNames).toContain("list_subagent_profiles");
    });

    it("should register get_subagent_output with non-empty description and parameters schema", () => {
      registerRetrievalTools(mockPi, sessionStore);

      const registration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find((call: [{ name: string }]) => call[0].name === "get_subagent_output")?.[0];
      expect(registration).toBeDefined();
      expect(registration!.description.length).toBeGreaterThan(0);
      expect(registration!.parameters).toBeDefined();
    });

    it("should register get_subagent_session with non-empty description and parameters schema", () => {
      registerRetrievalTools(mockPi, sessionStore);

      const registration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find(
          (call: [{ name: string }]) => call[0].name === "get_subagent_session",
        )?.[0];
      expect(registration).toBeDefined();
      expect(registration!.description.length).toBeGreaterThan(0);
      expect(registration!.parameters).toBeDefined();
    });

    it("should register list_subagent_profiles with non-empty description", () => {
      registerRetrievalTools(mockPi, sessionStore);

      const registration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find(
          (call: [{ name: string }]) => call[0].name === "list_subagent_profiles",
        )?.[0];
      expect(registration).toBeDefined();
      expect(registration!.description.length).toBeGreaterThan(0);
      expect(registration!.parameters).toBeDefined();
    });
  });

  describe("registerDelegateTool", () => {
    it("should register delegate_to_subagents with non-empty description and parameters schema", () => {
      const mockRegisterSession = vi.fn();
      const mockGetActiveSessionIds = vi.fn().mockReturnValue(new Set<string>());
      registerDelegateTool(mockPi, sessionStore, mockRegisterSession, mockGetActiveSessionIds);

      expect(mockPi.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "delegate_to_subagents",
        }),
      );

      const registration = vi
        .mocked(mockPi.registerTool)
        .mock.calls.find(
          (call: [{ name: string }]) => call[0].name === "delegate_to_subagents",
        )?.[0];
      expect(registration).toBeDefined();
      expect(registration!.description.length).toBeGreaterThan(0);
      expect(registration!.parameters).toBeDefined();
    });
  });

  describe("registerProfileCommand", () => {
    it("should register /profile command", () => {
      registerProfileCommand(mockPi);

      expect(mockPi.registerCommand).toHaveBeenCalledWith("profile", expect.any(Object));
    });
  });

  // ── sessionStore: get_subagent_output ───────────────────────────

  describe("get_subagent_output", () => {
    beforeEach(() => {
      vi.mocked(runSubAgent).mockClear();
    });

    it("should return last assistant text for valid session", async () => {
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
            content: [{ type: "text", text: "Final output from sub-agent" }],
          } as unknown as Message,
        ],
        exitCode: 0,
        startedAt: Date.now(),
      };
      sessionStore.set("test-session", { runs: [testSession] });

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

      expect(result.content[0]!.type).toBe("text");
      expect((result.content[0]! as { text: string }).text).toBe("Final output from sub-agent");
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

      expect((result.content[0]! as { text: string }).text).toBe("(no text output from sub-agent)");
    });
  });

  // ── sessionStore: get_subagent_session ──────────────────────────

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

      expect(result.content[0]!.type).toBe("text");
      expect((result.content[0]! as { text: string }).text).toContain("First response");
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

  // ── renderCall functions ────────────────────────────────────────

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

  // ── renderResult functions ──────────────────────────────────────

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
});
