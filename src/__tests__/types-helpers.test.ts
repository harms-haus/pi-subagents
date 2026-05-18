/**
 * Tests for helper functions in src/types.ts
 */

import { describe, expect, it } from "vitest";
import { syncState } from "../types";
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
