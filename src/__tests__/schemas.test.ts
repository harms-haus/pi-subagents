/**
 * Behavioral validation tests for src/schemas.ts
 *
 * These tests exercise meaningful edge cases for DelegateParams, TaskSchema,
 * and FileSpec using TypeBox Value.Check — not just trivial happy paths.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { DelegateParams, TaskSchema } from "../schemas";
import { MAX_PARALLEL_TASKS } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────

const validTask = (overrides: Record<string, unknown> = {}) => ({
  name: "test task",
  prompt: "do something",
  ...overrides,
});

// ── DelegateParams: valid cases ──────────────────────────────────────

describe("DelegateParams — valid params", () => {
  it("accepts minimal valid params (just tasks with name + prompt)", () => {
    const params = {
      tasks: [{ name: "task-a", prompt: "write tests" }],
    };

    expect(Value.Check(DelegateParams, params)).toBe(true);
  });

  it("accepts full params with all optional fields", () => {
    const params = {
      tasks: [
        {
          name: "task-a",
          prompt: "write tests",
          cwd: "/home/user/project",
          profile: "senior-dev",
          timeout: 300,
          resume: "session-abc123",
          files: ["src/index.ts"],
        },
      ],
      profile: "default-profile",
    };

    expect(Value.Check(DelegateParams, params)).toBe(true);
  });

  it("accepts multiple tasks", () => {
    const params = {
      tasks: [
        { name: "task-1", prompt: "first" },
        { name: "task-2", prompt: "second" },
        { name: "task-3", prompt: "third" },
      ],
    };

    expect(Value.Check(DelegateParams, params)).toBe(true);
  });

  it("accepts tasks with files parameter (string paths and file spec objects)", () => {
    const params = {
      tasks: [
        {
          name: "task-1",
          prompt: "review",
          files: [
            "plain/path.ts",
            { path: "range.ts", start: 1, end: 50 },
            { path: "tail.ts", tail: 20 },
            { path: "head.ts", head: 30 },
          ],
        },
      ],
    };

    expect(Value.Check(DelegateParams, params)).toBe(true);
  });
});

// ── DelegateParams: invalid cases ────────────────────────────────────

describe("DelegateParams — invalid params", () => {
  it("rejects missing tasks array", () => {
    const params = { profile: "default" };

    expect(Value.Check(DelegateParams, params)).toBe(false);
  });

  it("rejects empty tasks array (0 items)", () => {
    const params = { tasks: [] };

    expect(Value.Check(DelegateParams, params)).toBe(false);
  });

  it(`rejects tasks exceeding MAX_PARALLEL_TASKS (${MAX_PARALLEL_TASKS} items)`, () => {
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
      name: `task-${i}`,
      prompt: `do ${i}`,
    }));

    expect(Value.Check(DelegateParams, { tasks })).toBe(false);
  });

  it("accepts tasks array at exactly MAX_PARALLEL_TASKS (boundary)", () => {
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => ({
      name: `task-${i}`,
      prompt: `do ${i}`,
    }));

    expect(Value.Check(DelegateParams, { tasks })).toBe(true);
  });

  it("rejects task missing required 'name' field", () => {
    const params = {
      tasks: [{ prompt: "no name" }],
    };

    expect(Value.Check(DelegateParams, params)).toBe(false);
  });

  it("rejects task missing required 'prompt' field", () => {
    const params = {
      tasks: [{ name: "no prompt" }],
    };

    expect(Value.Check(DelegateParams, params)).toBe(false);
  });

  it("accepts negative timeout value (no minimum in schema)", () => {
    const params = {
      tasks: [validTask({ timeout: -1 })],
    };

    // TypeBox doesn't enforce minimum on timeout (no minimum specified in schema),
    // so negative values pass the schema. But let's verify actual behavior.
    // If the schema has no minimum, this will be true — that's a documentation test.
    expect(Value.Check(DelegateParams, params)).toBe(true);
  });

  it("accepts timeout of 0", () => {
    const params = {
      tasks: [validTask({ timeout: 0 })],
    };

    expect(Value.Check(DelegateParams, params)).toBe(true);
  });

  it("rejects invalid resume sessionId type (number instead of string)", () => {
    const params = {
      tasks: [validTask({ resume: 12345 })],
    };

    expect(Value.Check(DelegateParams, params)).toBe(false);
  });

  it("rejects invalid profile name type (number instead of string)", () => {
    const params = {
      tasks: [{ name: "task", prompt: "do", profile: 999 }],
    };

    expect(Value.Check(DelegateParams, params)).toBe(false);
  });

  it("rejects non-array tasks field", () => {
    expect(Value.Check(DelegateParams, { tasks: "not-array" })).toBe(false);
  });

  it("rejects when a single task in the array is invalid", () => {
    const params = {
      tasks: [
        { name: "valid", prompt: "ok" },
        { prompt: "missing name" },
      ],
    };

    expect(Value.Check(DelegateParams, params)).toBe(false);
  });
});

// ── FileSpec variants (via TaskSchema.files) ─────────────────────────

describe("FileSpec variants", () => {
  it("accepts plain string path", () => {
    const task = validTask({ files: ["src/foo.ts"] });

    expect(Value.Check(TaskSchema, task)).toBe(true);
  });

  it("accepts { path, start, end } range spec", () => {
    const task = validTask({ files: [{ path: "x.ts", start: 1, end: 5 }] });

    expect(Value.Check(TaskSchema, task)).toBe(true);
  });

  it("accepts { path, tail } tail spec", () => {
    const task = validTask({ files: [{ path: "x.ts", tail: 10 }] });

    expect(Value.Check(TaskSchema, task)).toBe(true);
  });

  it("accepts { path, head } head spec", () => {
    const task = validTask({ files: [{ path: "x.ts", head: 10 }] });

    expect(Value.Check(TaskSchema, task)).toBe(true);
  });

  // BUG: These values SHOULD be rejected (FileTailSchema has minimum: 1 on tail,
  // FileHeadSchema has minimum: 1 on head), but Value.Check passes them because
  // FileRangeSchema (path + optional start/end) matches first — it allows extra
  // properties, so { path, tail } matches FileRangeSchema instead of FileTailSchema.
  // Fix: add `additionalProperties: false` to FileRangeSchema in schemas.ts.
  it("BUG — accepts { path, tail: 0 } despite minimum:1 (matches FileRangeSchema)", () => {
    const task = validTask({ files: [{ path: "x.ts", tail: 0 }] });

    // Should be false, but FileRangeSchema allows additional properties
    expect(Value.Check(TaskSchema, task)).toBe(true);
  });

  it("BUG — accepts { path, tail: -1 } despite minimum:1 (matches FileRangeSchema)", () => {
    const task = validTask({ files: [{ path: "x.ts", tail: -1 }] });

    // Should be false, but FileRangeSchema allows additional properties
    expect(Value.Check(TaskSchema, task)).toBe(true);
  });

  it("BUG — accepts { path, head: 0 } despite minimum:1 (matches FileRangeSchema)", () => {
    const task = validTask({ files: [{ path: "x.ts", head: 0 }] });

    // Should be false, but FileRangeSchema allows additional properties
    expect(Value.Check(TaskSchema, task)).toBe(true);
  });

  it("accepts a mix of string paths and spec objects in the same array", () => {
    const task = validTask({
      files: [
        "plain.ts",
        { path: "range.ts", start: 10, end: 20 },
        { path: "tail.ts", tail: 5 },
        { path: "head.ts", head: 5 },
      ],
    });

    expect(Value.Check(TaskSchema, task)).toBe(true);
  });

  it("accepts range spec with only path (no start/end)", () => {
    const task = validTask({ files: [{ path: "x.ts" }] });

    expect(Value.Check(TaskSchema, task)).toBe(true);
  });
});

// ── TaskSchema: type enforcement ──────────────────────────────────────

describe("TaskSchema — type enforcement", () => {
  it("rejects non-string name", () => {
    expect(Value.Check(TaskSchema, validTask({ name: 123 }))).toBe(false);
  });

  it("rejects non-string prompt", () => {
    expect(Value.Check(TaskSchema, validTask({ prompt: 456 }))).toBe(false);
  });

  it("rejects non-string cwd", () => {
    expect(Value.Check(TaskSchema, validTask({ cwd: true }))).toBe(false);
  });

  it("rejects non-number timeout", () => {
    expect(Value.Check(TaskSchema, validTask({ timeout: "300" }))).toBe(false);
  });

  it("rejects non-string resume", () => {
    expect(Value.Check(TaskSchema, validTask({ resume: 999 }))).toBe(false);
  });

  it("rejects non-array files", () => {
    expect(Value.Check(TaskSchema, validTask({ files: "not-array" }))).toBe(false);
  });
});
