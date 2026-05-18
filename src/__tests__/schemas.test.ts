/**
 * Tests for src/schemas.ts
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { DelegateParams, TaskSchema } from "../schemas";
import { MAX_PARALLEL_TASKS } from "../types";

describe("TaskSchema", () => {
  it("should validate correct task structure with required fields", () => {
    const validTask = {
      name: "test task",
      prompt: "do something",
    };

    const result = Value.Check(TaskSchema, validTask);
    expect(result).toBe(true);
  });

  it("should validate task with optional cwd field", () => {
    const validTask = {
      name: "test task",
      prompt: "do something",
      cwd: "/some/path",
    };

    const result = Value.Check(TaskSchema, validTask);
    expect(result).toBe(true);
  });

  it("should validate task with optional profile field", () => {
    const validTask = {
      name: "test task",
      prompt: "do something",
      profile: "my-profile",
    };

    const result = Value.Check(TaskSchema, validTask);
    expect(result).toBe(true);
  });

  it("should validate task with all optional fields", () => {
    const validTask = {
      name: "test task",
      prompt: "do something",
      cwd: "/some/path",
      profile: "my-profile",
    };

    const result = Value.Check(TaskSchema, validTask);
    expect(result).toBe(true);
  });

  it("should reject task without required name field", () => {
    const invalidTask = {
      prompt: "do something",
    };

    const result = Value.Check(TaskSchema, invalidTask);
    expect(result).toBe(false);
  });

  it("should reject task without required prompt field", () => {
    const invalidTask = {
      name: "test task",
    };

    const result = Value.Check(TaskSchema, invalidTask);
    expect(result).toBe(false);
  });

  it("should accept task with empty name", () => {
    const task = {
      name: "",
      prompt: "do something",
    };

    const result = Value.Check(TaskSchema, task);
    expect(result).toBe(true);
  });

  it("should accept task with empty prompt", () => {
    const task = {
      name: "test task",
      prompt: "",
    };

    const result = Value.Check(TaskSchema, task);
    expect(result).toBe(true);
  });

  it("should reject task with non-string name", () => {
    const invalidTask = {
      name: 123,
      prompt: "do something",
    };

    const result = Value.Check(TaskSchema, invalidTask);
    expect(result).toBe(false);
  });

  it("should reject task with non-string prompt", () => {
    const invalidTask = {
      name: "test task",
      prompt: 123,
    };

    const result = Value.Check(TaskSchema, invalidTask);
    expect(result).toBe(false);
  });

  it("should accept task with timeout of 0", () => {
    const task = {
      name: "test task",
      prompt: "do something",
      timeout: 0,
    };

    const result = Value.Check(TaskSchema, task);
    expect(result).toBe(true);
  });
});

describe("TaskSchema - timeout and resume fields", () => {
  it("should validate task with timeout field", () => {
    const validTask = {
      name: "test",
      prompt: "do something",
      timeout: 300,
    };

    const result = Value.Check(TaskSchema, validTask);
    expect(result).toBe(true);
  });

  it("should validate task with resume field", () => {
    const validTask = {
      name: "test",
      prompt: "continue",
      resume: "abc123",
    };

    const result = Value.Check(TaskSchema, validTask);
    expect(result).toBe(true);
  });

  it("should validate task with both timeout and resume fields", () => {
    const validTask = {
      name: "test",
      prompt: "do something",
      timeout: 300,
      resume: "abc123",
    };

    const result = Value.Check(TaskSchema, validTask);
    expect(result).toBe(true);
  });

  it("should reject task with non-number timeout", () => {
    const invalidTask = {
      name: "test",
      prompt: "test",
      timeout: "300",
    };

    const result = Value.Check(TaskSchema, invalidTask);
    expect(result).toBe(false);
  });

  it("should reject task with non-string resume", () => {
    const invalidTask = {
      name: "test",
      prompt: "test",
      resume: 123,
    };

    const result = Value.Check(TaskSchema, invalidTask);
    expect(result).toBe(false);
  });

  it("should validate task without timeout or resume", () => {
    const validTask = {
      name: "test",
      prompt: "do something",
    };

    const result = Value.Check(TaskSchema, validTask);
    expect(result).toBe(true);
  });
});

describe("DelegateParams", () => {
  it("should validate correct params with single task", () => {
    const validParams = {
      tasks: [{ name: "test", prompt: "do something" }],
    };

    const result = Value.Check(DelegateParams, validParams);
    expect(result).toBe(true);
  });

  it("should validate params with multiple tasks", () => {
    const validParams = {
      tasks: [
        { name: "task1", prompt: "do something 1" },
        { name: "task2", prompt: "do something 2" },
        { name: "task3", prompt: "do something 3" },
      ],
    };

    const result = Value.Check(DelegateParams, validParams);
    expect(result).toBe(true);
  });

  it("should validate params with optional profile field", () => {
    const validParams = {
      tasks: [{ name: "test", prompt: "do something" }],
      profile: "default-profile",
    };

    const result = Value.Check(DelegateParams, validParams);
    expect(result).toBe(true);
  });

  it("should validate params with tasks that have optional fields", () => {
    const validParams = {
      tasks: [
        { name: "task1", prompt: "do something 1", cwd: "/path1" },
        { name: "task2", prompt: "do something 2", profile: "profile2" },
        { name: "task3", prompt: "do something 3", cwd: "/path3", profile: "profile3" },
      ],
      profile: "default-profile",
    };

    const result = Value.Check(DelegateParams, validParams);
    expect(result).toBe(true);
  });

  it("should reject params without tasks field", () => {
    const invalidParams = {
      profile: "default-profile",
    };

    const result = Value.Check(DelegateParams, invalidParams);
    expect(result).toBe(false);
  });

  it("should reject params with invalid task in array", () => {
    const invalidParams = {
      tasks: [
        { name: "valid", prompt: "do something" },
        { prompt: "missing name" }, // invalid task
      ],
    };

    const result = Value.Check(DelegateParams, invalidParams);
    expect(result).toBe(false);
  });

  it("should reject params with empty tasks array", () => {
    const invalidParams = {
      tasks: [],
    };

    const result = Value.Check(DelegateParams, invalidParams);
    expect(result).toBe(false);
  });

  it("should reject params with non-array tasks field", () => {
    const invalidParams = {
      tasks: "not an array",
    };

    const result = Value.Check(DelegateParams, invalidParams);
    expect(result).toBe(false);
  });

  it("should reject params with non-string profile", () => {
    const invalidParams = {
      tasks: [{ name: "test", prompt: "do something" }],
      profile: 123,
    };

    const result = Value.Check(DelegateParams, invalidParams);
    expect(result).toBe(false);
  });

  it(`should accept tasks array with exactly ${MAX_PARALLEL_TASKS} items (boundary)`, () => {
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => ({
      name: `task-${i}`,
      prompt: `do something ${i}`,
    }));
    const params = { tasks };

    const result = Value.Check(DelegateParams, params);
    expect(result).toBe(true);
  });

  it(`should reject tasks array with ${MAX_PARALLEL_TASKS + 1} items (exceeds MAX_PARALLEL_TASKS)`, () => {
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
      name: `task-${i}`,
      prompt: `do something ${i}`,
    }));
    const params = { tasks };

    const result = Value.Check(DelegateParams, params);
    expect(result).toBe(false);
  });
});
