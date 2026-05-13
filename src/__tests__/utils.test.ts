/**
 * Tests for src/utils.ts
 */

import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SubAgentWindow } from "../types";
import {
  appendLineToWindow,
  countWindowStatuses,
  getLastAssistantText,
  getSummaryText,
  getTextParts,
  mapWithConcurrencyLimit,
  stripAnsi,
} from "../utils";

describe("stripAnsi", () => {
  it("should return plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("should remove ANSI escape codes", () => {
    expect(stripAnsi("\u001b[31mhello\u001b[0m")).toBe("hello");
    expect(stripAnsi("\u001b[31mred\u001b[0m text \u001b[32mgreen\u001b[0m")).toBe("red text green");
  });

  it("should handle empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("should handle mixed ANSI and plain text", () => {
    expect(stripAnsi("\u001b[31merror:\u001b[0m something went wrong")).toBe("error: something went wrong");
  });
});

describe("appendLineToWindow", () => {
  it("should add lines within maxLines limit", () => {
    const win: SubAgentWindow = {
      sessionId: "test",
      status: "running",
      exitCode: null,
      name: "test-window",
      lines: [],
      allMessages: [],
    };

    appendLineToWindow(win, "line 1", 10);
    appendLineToWindow(win, "line 2", 10);
    appendLineToWindow(win, "line 3", 10);

    expect(win.lines).toHaveLength(3);
    expect(win.lines[0]).toEqual({ text: "line 1", kind: "text" });
    expect(win.lines[1]).toEqual({ text: "line 2", kind: "text" });
    expect(win.lines[2]).toEqual({ text: "line 3", kind: "text" });
    expect(win.allMessages).toHaveLength(3);
  });

  it("should evict oldest lines when exceeding maxLines", () => {
    const win: SubAgentWindow = {
      sessionId: "test",
      status: "running",
      exitCode: null,
      name: "test-window",
      lines: [],
      allMessages: [],
    };

    for (let i = 1; i <= 15; i++) {
      appendLineToWindow(win, `line ${i}`, 10);
    }

    expect(win.lines).toHaveLength(10);
    expect(win.lines[0]).toEqual({ text: "line 6", kind: "text" });
    expect(win.lines[9]).toEqual({ text: "line 15", kind: "text" });
    expect(win.allMessages).toHaveLength(15);
    expect(win.allMessages[0]).toEqual({ text: "line 1", kind: "text" });
  });

  it("should track allMessages even when lines buffer is bounded", () => {
    const win: SubAgentWindow = {
      sessionId: "test",
      status: "running",
      exitCode: null,
      name: "test-window",
      lines: [],
      allMessages: [],
    };

    for (let i = 1; i <= 20; i++) {
      appendLineToWindow(win, `line ${i}`, 5);
    }

    expect(win.lines).toHaveLength(5);
    expect(win.allMessages).toHaveLength(20);
    expect(win.lines[0]).toEqual({ text: "line 16", kind: "text" });
    expect(win.allMessages[0]).toEqual({ text: "line 1", kind: "text" });
    expect(win.allMessages[19]).toEqual({ text: "line 20", kind: "text" });
  });

  it("should drop whitespace-only lines", () => {
    const win: SubAgentWindow = {
      sessionId: "test",
      status: "running",
      exitCode: null,
      name: "test-window",
      lines: [],
      allMessages: [],
    };

    appendLineToWindow(win, "   ", 10);
    appendLineToWindow(win, "\t", 10);
    appendLineToWindow(win, "", 10);
    appendLineToWindow(win, "valid line", 10);

    expect(win.lines).toHaveLength(1);
    expect(win.lines[0]).toEqual({ text: "valid line", kind: "text" });
    expect(win.allMessages).toHaveLength(1);
  });

  it("should trim trailing whitespace from lines", () => {
    const win: SubAgentWindow = {
      sessionId: "test",
      status: "running",
      exitCode: null,
      name: "test-window",
      lines: [],
      allMessages: [],
    };

    appendLineToWindow(win, "hello   ", 10);
    appendLineToWindow(win, "world\t\t", 10);

    expect(win.lines[0]).toEqual({ text: "hello", kind: "text" });
    expect(win.lines[1]).toEqual({ text: "world", kind: "text" });
  });

  it("should remove ANSI codes before storing", () => {
    const win: SubAgentWindow = {
      sessionId: "test",
      status: "running",
      exitCode: null,
      name: "test-window",
      lines: [],
      allMessages: [],
    };

    appendLineToWindow(win, "\u001b[31merror\u001b[0m message", 10);

    expect(win.lines[0]).toEqual({ text: "error message", kind: "text" });
  });

  it("should handle tool kind parameter", () => {
    const win: SubAgentWindow = {
      sessionId: "test",
      status: "running",
      exitCode: null,
      name: "test-window",
      lines: [],
      allMessages: [],
    };

    appendLineToWindow(win, "tool output", 10, "tool");

    expect(win.lines[0]).toEqual({ text: "tool output", kind: "tool" });
  });
});

describe("mapWithConcurrencyLimit", () => {
  it("should return empty array for empty input", async () => {
    const result = await mapWithConcurrencyLimit([], 3, async (item) => item * 2);
    expect(result).toEqual([]);
  });

  it("should process single item", async () => {
    const result = await mapWithConcurrencyLimit([5], 3, async (item) => item * 2);
    expect(result).toEqual([10]);
  });

  it("should respect concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 2, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("should preserve ordering", async () => {
    const delays = [30, 10, 20];
    const results = await mapWithConcurrencyLimit(delays, 3, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });

    expect(results).toEqual([0, 1, 2]);
  });

  it("should reject if any item fails", async () => {
    await expect(
      mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (item) => {
        if (item === 3) throw new Error("Item 3 failed");
        return item * 2;
      }),
    ).rejects.toThrow("Item 3 failed");
  });

  it("should handle concurrency of 1 (sequential)", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 1, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBe(1);
  });
});

describe("getLastAssistantText", () => {
  it("should return undefined for empty array", () => {
    expect(getLastAssistantText([])).toBe("");
  });

  it("should return undefined when no assistant messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "tool output" }],
      },
    ];
    expect(getLastAssistantText(messages)).toBe("");
  });

  it("should return text from single assistant message", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant response" }],
      },
    ];
    expect(getLastAssistantText(messages)).toBe("assistant response");
  });

  it("should return text from last assistant message", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "follow up" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second response" }],
      },
    ];
    expect(getLastAssistantText(messages)).toBe("second response");
  });

  it("should handle mixed roles and return last assistant text", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "response 1" }],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "tool output" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "response 2" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "question" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "response 3" }],
      },
    ];
    expect(getLastAssistantText(messages)).toBe("response 3");
  });
});

describe("getSummaryText", () => {
  it("should show running count when all running", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "running",
        exitCode: null,
        name: "test1",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "2",
        status: "running",
        exitCode: null,
        name: "test2",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "3",
        status: "running",
        exitCode: null,
        name: "test3",
        lines: [],
        allMessages: [],
      },
    ];
    expect(getSummaryText(windows)).toBe("3 running");
  });

  it("should show all counts for mixed statuses", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "running",
        exitCode: null,
        name: "test1",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "2",
        status: "completed",
        exitCode: 0,
        name: "test2",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "3",
        status: "completed",
        exitCode: 0,
        name: "test3",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "4",
        status: "error",
        exitCode: 1,
        name: "test4",
        lines: [],
        allMessages: [],
      },
    ];
    expect(getSummaryText(windows)).toBe("1 running, 2 done, 1 error");
  });

  it("should show processing for empty array", () => {
    expect(getSummaryText([])).toBe("processing...");
  });

  it("should pluralize errors when more than one", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "error",
        exitCode: 1,
        name: "test1",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "2",
        status: "error",
        exitCode: 1,
        name: "test2",
        lines: [],
        allMessages: [],
      },
    ];
    expect(getSummaryText(windows)).toBe("2 errors");
  });

  it("should not pluralize single error", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "error",
        exitCode: 1,
        name: "test1",
        lines: [],
        allMessages: [],
      },
    ];
    expect(getSummaryText(windows)).toBe("1 error");
  });

  it("should show only done when all completed", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "completed",
        exitCode: 0,
        name: "test1",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "2",
        status: "completed",
        exitCode: 0,
        name: "test2",
        lines: [],
        allMessages: [],
      },
    ];
    expect(getSummaryText(windows)).toBe("2 done");
  });
});

describe("countWindowStatuses", () => {
  it("should count all running windows", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "running",
        exitCode: null,
        name: "test1",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "2",
        status: "running",
        exitCode: null,
        name: "test2",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "3",
        status: "running",
        exitCode: null,
        name: "test3",
        lines: [],
        allMessages: [],
      },
    ];
    expect(countWindowStatuses(windows)).toEqual({ running: 3, completed: 0, error: 0 });
  });

  it("should count all completed windows", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "completed",
        exitCode: 0,
        name: "test1",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "2",
        status: "completed",
        exitCode: 0,
        name: "test2",
        lines: [],
        allMessages: [],
      },
    ];
    expect(countWindowStatuses(windows)).toEqual({ running: 0, completed: 2, error: 0 });
  });

  it("should count all error windows", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "error",
        exitCode: 1,
        name: "test1",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "2",
        status: "error",
        exitCode: 1,
        name: "test2",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "3",
        status: "error",
        exitCode: 1,
        name: "test3",
        lines: [],
        allMessages: [],
      },
    ];
    expect(countWindowStatuses(windows)).toEqual({ running: 0, completed: 0, error: 3 });
  });

  it("should count mixed statuses correctly", () => {
    const windows: SubAgentWindow[] = [
      {
        sessionId: "1",
        status: "running",
        exitCode: null,
        name: "test1",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "2",
        status: "completed",
        exitCode: 0,
        name: "test2",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "3",
        status: "completed",
        exitCode: 0,
        name: "test3",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "4",
        status: "error",
        exitCode: 1,
        name: "test4",
        lines: [],
        allMessages: [],
      },
      {
        sessionId: "5",
        status: "running",
        exitCode: null,
        name: "test5",
        lines: [],
        allMessages: [],
      },
    ];
    expect(countWindowStatuses(windows)).toEqual({ running: 2, completed: 2, error: 1 });
  });

  it("should return zeros for empty array", () => {
    expect(countWindowStatuses([])).toEqual({ running: 0, completed: 0, error: 0 });
  });
});

describe("getTextParts", () => {
  it("should extract text parts from assistant message", () => {
    const message: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
    };
    expect(getTextParts(message)).toEqual(["Hello", " world"]);
  });

  it("should return empty array for non-assistant message", () => {
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    expect(getTextParts(message)).toEqual([]);
  });

  it("should return empty array for message with no content", () => {
    const message: Message = {
      role: "assistant",
      content: undefined,
    };
    expect(getTextParts(message)).toEqual([]);
  });

  it("should filter out non-text parts", () => {
    const message: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "text part" },
        { type: "toolCall", name: "someTool", arguments: {} },
        { type: "text", text: "another text" },
      ],
    };
    expect(getTextParts(message)).toEqual(["text part", "another text"]);
  });

  it("should return empty array when no text parts exist", () => {
    const message: Message = {
      role: "assistant",
      content: [
        { type: "toolCall", name: "tool1", arguments: {} },
        { type: "toolCall", name: "tool2", arguments: {} },
      ],
    };
    expect(getTextParts(message)).toEqual([]);
  });
});
