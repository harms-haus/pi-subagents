import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerProfileCommand } from "../commands/profile";
import { registerDelegateTool } from "../tools/delegate";
import { registerRetrievalTools } from "../tools/retrieval";
import type { SubagentSessionData } from "../types";
import { countWindowStatuses } from "../utils";

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
    Optional: vi.fn((fn: unknown) => fn),
    Array: vi.fn(() => ({})),
  },
}));

describe("tools", () => {
  describe("tool registration", () => {
    let mockPi: ExtensionAPI;
    let sessionStore: Map<string, SubagentSessionData>;
    let mockRegisterSession: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      sessionStore = new Map();
      mockRegisterSession = vi.fn();

      mockPi = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        on: vi.fn(),
        ui: {
          notify: vi.fn(),
          confirm: vi.fn(),
        },
      } as unknown as ExtensionAPI;
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

        const toolNames = vi.mocked(mockPi.registerTool).mock.calls.map((call) => call[0].name);
        expect(toolNames).toContain("get_subagent_output");
        expect(toolNames).toContain("get_subagent_session");
        expect(toolNames).toContain("list_subagent_profiles");
      });
    });

    describe("registerDelegateTool", () => {
      it("should register delegate_to_subagents tool", () => {
        registerDelegateTool(mockPi, sessionStore, mockRegisterSession);

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
    let sessionStore: Map<string, SubagentSessionData>;
    let mockPi: ExtensionAPI;

    beforeEach(() => {
      sessionStore = new Map();
      mockPi = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        on: vi.fn(),
      } as unknown as ExtensionAPI;
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
            },
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set("test-session", testSession);

        // Get the tool execute function
        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_output");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }
        const result = await executeFn("tool-call-id", { sessionId: "test-session" }, null, vi.fn(), null);

        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toBe("Final output from sub-agent");
        expect(result.details.sessionId).toBe("test-session");
      });

      it("should throw error for invalid session ID", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_output");
        expect(toolRegistration).toBeDefined();

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        await expect(
          executeFn("tool-call-id", { sessionId: "non-existent-session" }, null, vi.fn(), null),
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
        sessionStore.set("test-session", testSession);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_output");
        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }
        const result = await executeFn("tool-call-id", { sessionId: "test-session" }, null, vi.fn(), null);

        expect(result.content[0].text).toBe("(no text output from sub-agent)");
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
                } as const,
              ],
            },
          ],
          exitCode: 0,
          startedAt: Date.now(),
        };
        sessionStore.set("test-session", testSession);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_session");
        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }
        const result = await executeFn("tool-call-id", { sessionId: "test-session" }, null, vi.fn(), null);

        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toContain("First response");
        expect(result.details.messageCount).toBe(1);
      });

      it("should throw error for invalid session ID", async () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_session");

        const executeFn = toolRegistration?.[0].execute;
        if (!executeFn) {
          throw new Error("Tool not registered");
        }

        await expect(executeFn("tool-call-id", { sessionId: "non-existent" }, null, vi.fn(), null)).rejects.toThrow(
          'Session "non-existent" not found',
        );
      });
    });

    describe("renderCall functions", () => {
      it("should render get_subagent_output call with session ID", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_output");
        const renderCall = toolRegistration?.[0].renderCall;
        if (!renderCall) {
          throw new Error("Tool not registered");
        }

        const mockTheme = {
          fg: vi.fn((_color: string, text: string) => text),
          bold: vi.fn((text: string) => text),
        } as unknown as Theme;

        renderCall({ sessionId: "test-123" }, mockTheme, null as unknown);

        expect(mockTheme.fg).toHaveBeenCalledWith("accent", "test-123");
      });

      it("should render get_subagent_output call without session ID (placeholder)", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_output");
        const renderCall = toolRegistration?.[0].renderCall;
        if (!renderCall) {
          throw new Error("Tool not registered");
        }

        const mockTheme = {
          fg: vi.fn((_color: string, text: string) => text),
          bold: vi.fn((text: string) => text),
        } as unknown as Theme;

        renderCall({}, mockTheme, null as unknown);

        expect(mockTheme.fg).toHaveBeenCalledWith("accent", "...");
      });

      it("should render get_subagent_session call with session ID", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_session");
        const renderCall = toolRegistration?.[0].renderCall;
        if (!renderCall) {
          throw new Error("Tool not registered");
        }

        const mockTheme = {
          fg: vi.fn((_color: string, text: string) => text),
          bold: vi.fn((text: string) => text),
        } as unknown as Theme;

        renderCall({ sessionId: "session-456" }, mockTheme, null as unknown);

        expect(mockTheme.fg).toHaveBeenCalledWith("accent", "session-456");
      });
    });

    describe("renderResult functions", () => {
      it("should render result with text content", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_output");
        const renderResult = toolRegistration?.[0].renderResult;
        if (!renderResult) {
          throw new Error("Tool not registered");
        }

        const mockTheme = {
          fg: vi.fn((_color: string, text: string) => text),
        } as unknown as Theme;

        const result = {
          content: [{ type: "text", text: "Test output content" }],
        };

        renderResult(result, { expanded: false }, mockTheme, null as unknown);

        expect(mockTheme.fg).toHaveBeenCalledWith("toolOutput", "Test output content");
      });

      it("should render result with no text content (default label)", () => {
        registerRetrievalTools(mockPi, sessionStore);

        const toolRegistration = vi
          .mocked(mockPi.registerTool)
          .mock.calls.find((call) => call[0].name === "get_subagent_output");
        const renderResult = toolRegistration?.[0].renderResult;
        if (!renderResult) {
          throw new Error("Tool not registered");
        }

        const mockTheme = {
          fg: vi.fn((_color: string, text: string) => text),
        } as unknown as Theme;

        // When content is not text type, it should use default label
        const result = {
          content: [{} as { type: string }],
        };

        renderResult(result, { expanded: false }, mockTheme, null as unknown);

        expect(mockTheme.fg).toHaveBeenCalledWith("toolOutput", "(no output)");
      });
    });
  });

  describe("utils", () => {
    describe("countWindowStatuses", () => {
      it("should count all running windows", () => {
        const windows = [{ status: "running" }, { status: "running" }, { status: "running" }] as const[];

        const result = countWindowStatuses(windows);

        expect(result.running).toBe(3);
        expect(result.completed).toBe(0);
        expect(result.error).toBe(0);
      });

      it("should count all completed windows", () => {
        const windows = [{ status: "completed" }, { status: "completed" }] as const[];

        const result = countWindowStatuses(windows);

        expect(result.running).toBe(0);
        expect(result.completed).toBe(2);
        expect(result.error).toBe(0);
      });

      it("should count all error windows", () => {
        const windows = [{ status: "error" }, { status: "error" }, { status: "error" }] as const[];

        const result = countWindowStatuses(windows);

        expect(result.running).toBe(0);
        expect(result.completed).toBe(0);
        expect(result.error).toBe(3);
      });

      it("should count mixed status windows", () => {
        const windows = [
          { status: "running" },
          { status: "completed" },
          { status: "error" },
          { status: "running" },
          { status: "completed" },
        ] as const[];

        const result = countWindowStatuses(windows);

        expect(result.running).toBe(2);
        expect(result.completed).toBe(2);
        expect(result.error).toBe(1);
      });

      it("should handle empty array", () => {
        const windows: readonly { status: string }[] = [];

        const result = countWindowStatuses(windows);

        expect(result.running).toBe(0);
        expect(result.completed).toBe(0);
        expect(result.error).toBe(0);
      });
    });
  });
});
