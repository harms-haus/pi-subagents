/**
 * Tests for helper functions in src/types.ts
 */

import { describe, expect, it } from "vitest";
import { syncState, serializeSessionData, deserializeSessionData, CUSTOM_ENTRY_TYPE } from "../types";
import type { SubagentSessionData } from "../types";
import { makeWindow, makeSession } from "./helpers";

// ── syncState ──────────────────────────────────────────────────────────

describe("syncState", () => {
  it("should copy all 5 state fields from source to target", () => {
    const source = makeWindow({
      status: "completed",
      exitCode: 0,
      model: "gpt-4",
      stopReason: "endTurn",
      errorMessage: undefined,
    });
    const target = makeSession({
      status: "running",
      exitCode: null,
      model: undefined,
      stopReason: undefined,
      errorMessage: undefined,
    });

    syncState(source, target);

    expect(target.status).toBe("completed");
    expect(target.exitCode).toBe(0);
    expect(target.model).toBe("gpt-4");
    expect(target.stopReason).toBe("endTurn");
    expect(target.errorMessage).toBeUndefined();
  });

  it("should copy error-related fields", () => {
    const source = makeSession({
      status: "error",
      exitCode: 1,
      errorMessage: "Something went wrong",
      stopReason: "toolLimit",
    });
    const target = makeWindow();

    syncState(source, target);

    expect(target.status).toBe("error");
    expect(target.exitCode).toBe(1);
    expect(target.errorMessage).toBe("Something went wrong");
    expect(target.stopReason).toBe("toolLimit");
  });

  it("should not copy fields not in SubagentState (e.g., sessionId, name)", () => {
    const source = makeWindow({
      sessionId: "source-session-id",
      name: "source-name",
      status: "completed",
      exitCode: 0,
    });
    const target = makeSession({
      sessionId: "target-session-id",
      taskName: "target-task",
      status: "running",
      exitCode: null,
    });

    syncState(source, target);

    // sessionId and taskName should remain unchanged
    expect(target.sessionId).toBe("target-session-id");
    expect(target.taskName).toBe("target-task");
    // State fields should be synced
    expect(target.status).toBe("completed");
    expect(target.exitCode).toBe(0);
  });

  it("should handle undefined source fields by setting target to undefined", () => {
    const source = makeWindow({
      status: "completed",
      exitCode: 0,
      model: undefined,
      stopReason: undefined,
      errorMessage: undefined,
    });
    const target = makeSession({
      status: "running",
      exitCode: null,
      model: "initial-model",
      stopReason: "initial-reason",
      errorMessage: "initial error",
    });

    syncState(source, target);

    expect(target.model).toBeUndefined();
    expect(target.stopReason).toBeUndefined();
    expect(target.errorMessage).toBeUndefined();
    expect(target.status).toBe("completed");
    expect(target.exitCode).toBe(0);
  });

  it("should work syncing from session to window", () => {
    const source = makeSession({
      status: "error",
      exitCode: 137,
      model: "claude-3",
      stopReason: "timeout",
      errorMessage: "Process killed",
    });
    const target = makeWindow();

    syncState(source, target);

    expect(target.status).toBe("error");
    expect(target.exitCode).toBe(137);
    expect(target.model).toBe("claude-3");
    expect(target.stopReason).toBe("timeout");
    expect(target.errorMessage).toBe("Process killed");
    // window-specific fields should be untouched
    expect(target.name).toBe("test-window");
    expect(target.lines).toEqual([]);
  });
});

// ── serializeSessionData / deserializeSessionData ─────────────────────

describe("serializeSessionData / deserializeSessionData", () => {
  it("should round-trip a completed session", () => {
    const session: SubagentSessionData = {
      sessionId: "sess-1",
      taskName: "my-task",
      prompt: "Do the thing",
      status: "completed",
      exitCode: 0,
      startedAt: 1700000000000,
      messages: [
        {
          role: "user",
          content: "Hello from sub-agent",
          timestamp: 1700000000000,
        },
      ],
    };

    const serialized = serializeSessionData(session);
    const deserialized = deserializeSessionData(serialized);

    expect(deserialized).not.toBeNull();
    const result = deserialized!;
    expect(result.sessionId).toBe("sess-1");
    expect(result.taskName).toBe("my-task");
    expect(result.prompt).toBe("Do the thing");
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.startedAt).toBe(1700000000000);
    expect(result.messages).toEqual(session.messages);
  });

  it("should round-trip an errored session", () => {
    const session: SubagentSessionData = {
      sessionId: "sess-2",
      taskName: "failing-task",
      prompt: "This will fail",
      status: "error",
      exitCode: 1,
      errorMessage: "something failed",
      startedAt: 1700000001000,
      messages: [],
    };

    const serialized = serializeSessionData(session);
    const deserialized = deserializeSessionData(serialized);

    expect(deserialized).not.toBeNull();
    const result = deserialized!;
    expect(result.sessionId).toBe("sess-2");
    expect(result.taskName).toBe("failing-task");
    expect(result.prompt).toBe("This will fail");
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("something failed");
    expect(result.startedAt).toBe(1700000001000);
    expect(result.messages).toEqual([]);
  });

  it("should convert stale running sessions to error status", () => {
    const session: SubagentSessionData = {
      sessionId: "sess-3",
      taskName: "stale-task",
      prompt: "Running forever",
      status: "running",
      exitCode: null,
      startedAt: 1700000002000,
      messages: [],
    };

    const serialized = serializeSessionData(session);
    const deserialized = deserializeSessionData(serialized);

    expect(deserialized).not.toBeNull();
    const result = deserialized!;
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("interrupted");
  });

  it("should preserve existing errorMessage for stale running sessions", () => {
    const session: SubagentSessionData = {
      sessionId: "sess-4",
      taskName: "stale-with-error",
      prompt: "Running with error",
      status: "running",
      exitCode: null,
      errorMessage: "original error",
      startedAt: 1700000003000,
      messages: [],
    };

    const serialized = serializeSessionData(session);
    const deserialized = deserializeSessionData(serialized);

    expect(deserialized).not.toBeNull();
    const result = deserialized!;
    expect(result.status).toBe("error");
    expect(result.errorMessage).toBe("original error");
  });

  it("should return null for null data", () => {
    expect(deserializeSessionData(null)).toBeNull();
  });

  it("should return null for non-object data", () => {
    expect(deserializeSessionData("string")).toBeNull();
    expect(deserializeSessionData(42)).toBeNull();
  });

  it("should return null for data missing required fields", () => {
    expect(deserializeSessionData({ sessionId: "abc" })).toBeNull();
  });

  it("should return null for invalid status value", () => {
    const data = {
      sessionId: "sess-5",
      taskName: "bad-status",
      prompt: "test",
      status: "unknown",
      exitCode: 0,
      messages: [],
      startedAt: 1700000004000,
    };

    expect(deserializeSessionData(data)).toBeNull();
  });

  it("should return null for messages with invalid structure", () => {
    const data = {
      sessionId: "abc",
      taskName: "test",
      prompt: "test",
      status: "completed",
      messages: [{ notRole: "missing role field" }],
      exitCode: 0,
      startedAt: 1000,
    };
    expect(deserializeSessionData(data)).toBeNull();
  });

  it("should return null for messages array exceeding size limit", () => {
    const messages = Array(1001).fill({ role: "user", content: [] });
    const data = {
      sessionId: "abc",
      taskName: "test",
      prompt: "test",
      status: "completed",
      messages,
      exitCode: 0,
      startedAt: 1000,
    };
    expect(deserializeSessionData(data)).toBeNull();
  });

  it("should verify CUSTOM_ENTRY_TYPE constant", () => {
    expect(CUSTOM_ENTRY_TYPE).toBe("pi-subagents");
  });
});
