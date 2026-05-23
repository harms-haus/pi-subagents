/**
 * Tests for src/utils.ts
 */

import { homedir } from "node:os";

import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SubAgentWindow } from "../types";
import { makeWindow } from "./helpers";
import {
  collapseCdDot,
  formatBashCommand,
  shortenPath,
  shortenPathsInText,
} from "../format-tool-call";
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
    expect(stripAnsi("\u001b[31mred\u001b[0m text \u001b[32mgreen\u001b[0m")).toBe(
      "red text green",
    );
  });

  it("should handle empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("should handle mixed ANSI and plain text", () => {
    expect(stripAnsi("\u001b[31merror:\u001b[0m something went wrong")).toBe(
      "error: something went wrong",
    );
  });
});

describe("appendLineToWindow", () => {
  it("should add lines within maxLines limit", () => {
    const win = makeWindow();

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
    const win = makeWindow();

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
    const win = makeWindow();

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
    const win = makeWindow();

    appendLineToWindow(win, "   ", 10);
    appendLineToWindow(win, "\t", 10);
    appendLineToWindow(win, "", 10);
    appendLineToWindow(win, "valid line", 10);

    expect(win.lines).toHaveLength(1);
    expect(win.lines[0]).toEqual({ text: "valid line", kind: "text" });
    expect(win.allMessages).toHaveLength(1);
  });

  it("should trim trailing whitespace from lines", () => {
    const win = makeWindow();

    appendLineToWindow(win, "hello   ", 10);
    appendLineToWindow(win, "world\t\t", 10);

    expect(win.lines[0]).toEqual({ text: "hello", kind: "text" });
    expect(win.lines[1]).toEqual({ text: "world", kind: "text" });
  });

  it("should remove ANSI codes before storing", () => {
    const win = makeWindow();

    appendLineToWindow(win, "\u001b[31merror\u001b[0m message", 10);

    expect(win.lines[0]).toEqual({ text: "error message", kind: "text" });
  });

  it("should handle tool kind parameter", () => {
    const win = makeWindow();

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
        if (item === 3) {
          throw new Error("Item 3 failed");
        }
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
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "tool output" }],
      },
    ] as unknown as Message[];
    expect(getLastAssistantText(messages)).toBe("");
  });

  it("should return text from single assistant message", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant response" }],
      },
    ] as unknown as Message[];
    expect(getLastAssistantText(messages)).toBe("assistant response");
  });

  it("should return text from last assistant message", () => {
    const messages = [
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
    ] as unknown as Message[];
    expect(getLastAssistantText(messages)).toBe("second response");
  });

  it("should handle mixed roles and return last assistant text", () => {
    const messages = [
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
    ] as unknown as Message[];
    expect(getLastAssistantText(messages)).toBe("response 3");
  });
});

describe("getSummaryText", () => {
  it("should show running count when all running", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", name: "test1" }),
      makeWindow({ sessionId: "2", name: "test2" }),
      makeWindow({ sessionId: "3", name: "test3" }),
    ];
    expect(getSummaryText(windows)).toBe("3 running");
  });

  it("should show all counts for mixed statuses", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", name: "test1" }),
      makeWindow({ sessionId: "2", status: "completed", exitCode: 0, name: "test2" }),
      makeWindow({ sessionId: "3", status: "completed", exitCode: 0, name: "test3" }),
      makeWindow({ sessionId: "4", status: "error", exitCode: 1, name: "test4" }),
    ];
    expect(getSummaryText(windows)).toBe("1 running, 2 done, 1 error");
  });

  it("should show processing for empty array", () => {
    expect(getSummaryText([])).toBe("processing...");
  });

  it("should pluralize errors when more than one", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", status: "error", exitCode: 1, name: "test1" }),
      makeWindow({ sessionId: "2", status: "error", exitCode: 1, name: "test2" }),
    ];
    expect(getSummaryText(windows)).toBe("2 errors");
  });

  it("should not pluralize single error", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", status: "error", exitCode: 1, name: "test1" }),
    ];
    expect(getSummaryText(windows)).toBe("1 error");
  });

  it("should show only done when all completed", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", status: "completed", exitCode: 0, name: "test1" }),
      makeWindow({ sessionId: "2", status: "completed", exitCode: 0, name: "test2" }),
    ];
    expect(getSummaryText(windows)).toBe("2 done");
  });
});

describe("countWindowStatuses", () => {
  it("should count all running windows", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", name: "test1" }),
      makeWindow({ sessionId: "2", name: "test2" }),
      makeWindow({ sessionId: "3", name: "test3" }),
    ];
    expect(countWindowStatuses(windows)).toEqual({ running: 3, completed: 0, error: 0 });
  });

  it("should count all completed windows", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", status: "completed", exitCode: 0, name: "test1" }),
      makeWindow({ sessionId: "2", status: "completed", exitCode: 0, name: "test2" }),
    ];
    expect(countWindowStatuses(windows)).toEqual({ running: 0, completed: 2, error: 0 });
  });

  it("should count all error windows", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", status: "error", exitCode: 1, name: "test1" }),
      makeWindow({ sessionId: "2", status: "error", exitCode: 1, name: "test2" }),
      makeWindow({ sessionId: "3", status: "error", exitCode: 1, name: "test3" }),
    ];
    expect(countWindowStatuses(windows)).toEqual({ running: 0, completed: 0, error: 3 });
  });

  it("should count mixed statuses correctly", () => {
    const windows: SubAgentWindow[] = [
      makeWindow({ sessionId: "1", name: "test1" }),
      makeWindow({ sessionId: "2", status: "completed", exitCode: 0, name: "test2" }),
      makeWindow({ sessionId: "3", status: "completed", exitCode: 0, name: "test3" }),
      makeWindow({ sessionId: "4", status: "error", exitCode: 1, name: "test4" }),
      makeWindow({ sessionId: "5", name: "test5" }),
    ];
    expect(countWindowStatuses(windows)).toEqual({ running: 2, completed: 2, error: 1 });
  });

  it("should return zeros for empty array", () => {
    expect(countWindowStatuses([])).toEqual({ running: 0, completed: 0, error: 0 });
  });
});

describe("getTextParts", () => {
  it("should extract text parts from assistant message", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
    } as unknown as Message;
    expect(getTextParts(message)).toEqual(["Hello", " world"]);
  });

  it("should return empty array for non-assistant message", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    } as unknown as Message;
    expect(getTextParts(message)).toEqual([]);
  });

  it("should return empty array for message with no content", () => {
    const message = {
      role: "assistant",
      content: [] as any,
    } as unknown as Message;
    expect(getTextParts(message)).toEqual([]);
  });

  it("should filter out non-text parts", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "text part" },
        { type: "toolCall", id: "tc-1", name: "someTool", arguments: {} },
        { type: "text", text: "another text" },
      ],
    } as unknown as Message;
    expect(getTextParts(message)).toEqual(["text part", "another text"]);
  });

  it("should return empty array when no text parts exist", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: "tool1", arguments: {} },
        { type: "toolCall", id: "tc-2", name: "tool2", arguments: {} },
      ],
    } as unknown as Message;
    expect(getTextParts(message)).toEqual([]);
  });
});

describe("shortenPath", () => {
  it("should return '.' when path is identical to cwd", () => {
    expect(shortenPath("/home/user/project", "/home/user/project")).toBe(".");
  });

  it("should return relative child path without ./ prefix", () => {
    expect(shortenPath("/home/user/project/src/file.ts", "/home/user/project")).toBe("src/file.ts");
  });

  it("should return relative path for deeply nested child", () => {
    expect(
      shortenPath("/home/user/project/src/utils/helpers/format.ts", "/home/user/project"),
    ).toBe("src/utils/helpers/format.ts");
  });

  it("should keep display path for parent directory when savings are small", () => {
    const result = shortenPath("/home/user", "/home/user/project");
    // rel is ".." (2 chars), displayPath is "/home/user" (10 chars), savings = 8 < 10
    expect(result).toBe("/home/user");
  });

  it("should keep absolute path when relative is longer", () => {
    // /opt/some/deep/path/file.txt from /home/user/project
    // relative would be ../../../opt/some/deep/path/file.txt (longer)
    const result = shortenPath("/opt/some/deep/path/file.txt", "/home/user/project");
    // The relative path is longer, so the absolute path is kept
    expect(result).toBe("/opt/some/deep/path/file.txt");
  });

  it("should substitute home directory with ~ when shorter than relative", () => {
    const home = homedir();
    const cwd = `${home}/projects/myapp`;
    const path = `${home}/other/file.txt`;
    const result = shortenPath(path, cwd);
    // Should use ~/other/file.txt since it's shorter than ../../other/file.txt
    expect(result).toBe("~/other/file.txt");
  });

  it("should keep display path for ascending path when savings are small", () => {
    const home = homedir();
    const cwd = `${home}/a/b`;
    const path = `${home}/a/lib.ts`;
    const result = shortenPath(path, cwd);
    // rel is "../lib.ts" (9 chars), displayPath is "~/a/lib.ts" (10 chars), savings = 1 < 10
    expect(result).toBe("~/a/lib.ts");
  });
});

describe("shortenPathsInText", () => {
  it("should shorten a single path matching cwd prefix", () => {
    const cwd = "/home/user/project";
    expect(shortenPathsInText("cat /home/user/project/file.txt", cwd)).toBe("cat file.txt");
  });

  it("should shorten multiple paths in one command", () => {
    const cwd = "/home/user/project";
    expect(shortenPathsInText("cp /home/user/project/a.txt /home/user/project/b.txt", cwd)).toBe(
      "cp a.txt b.txt",
    );
  });

  it("should not modify URLs", () => {
    const cwd = "/home/user/project";
    expect(shortenPathsInText("curl https://example.com/api/data", cwd)).toBe(
      "curl https://example.com/api/data",
    );
  });

  it("should leave text without paths unchanged", () => {
    const cwd = "/home/user/project";
    expect(shortenPathsInText("echo hello", cwd)).toBe("echo hello");
  });

  it("should shorten path at start of text", () => {
    const cwd = "/home/user/project";
    expect(shortenPathsInText("/home/user/project/run.sh arg1", cwd)).toBe("run.sh arg1");
  });
});

describe("formatBashCommand", () => {
  it("should return short command unchanged", () => {
    expect(formatBashCommand("short-cmd", 40)).toBe("short-cmd");
  });

  it("should return command that exactly fits the width budget", () => {
    expect(formatBashCommand("exactly-20-chars----", 20)).toBe("exactly-20-chars----");
  });

  it("should truncate a single segment that exceeds the budget", () => {
    expect(formatBashCommand("a-very-long-command-that-exceeds-the-budget", 20)).toBe(
      "a-very-long-comma...",
    );
  });

  it("should split on && when segments don't fit together", () => {
    expect(formatBashCommand("short && long-command-exceeds-budget", 15)).toBe(
      "short &&\n\u2502 long-command...",
    );
  });

  it("should split multiple && segments onto separate lines", () => {
    expect(formatBashCommand("a && b && c", 5)).toBe("a &&\n\u2502 b &&\n\u2502 c");
  });

  it("should truncate oversized segment in the middle with more after", () => {
    expect(
      formatBashCommand("short && also-short && very-very-very-long-command && last", 25),
    ).toBe("short && also-short &&\n\u2502 very-very-very-long-co... &&\n\u2502 last");
  });

  it("should truncate oversized segment at the end", () => {
    expect(formatBashCommand("short && also-short && very-very-very-long-command", 25)).toBe(
      "short && also-short &&\n\u2502 very-very-very-long-co...",
    );
  });

  it("should return empty string for empty command", () => {
    expect(formatBashCommand("", 40)).toBe("");
  });

  it("should truncate to budget with very small width", () => {
    expect(formatBashCommand("some-command", 5)).toBe("so...");
  });

  it("should truncate long command without && delimiters", () => {
    expect(formatBashCommand("a-very-long-command-without-ampersands", 20)).toBe(
      "a-very-long-comma...",
    );
  });

  it("should keep all segments on one line when they fit together", () => {
    expect(formatBashCommand("a && b && c", 15)).toBe("a && b && c");
  });

  it("should truncate to just '...' when width budget is 3", () => {
    // budget 3: slice(0, 0) + "..." = "..."
    expect(formatBashCommand("some-command", 3)).toBe("...");
  });

  it("should truncate aggressively when width budget is 2", () => {
    // budget 2: slice(0, -1) removes last char, then appends "..."
    expect(formatBashCommand("some-command", 2)).toBe("some-comman...");
  });

  it("should truncate aggressively when width budget is 1", () => {
    // budget 1: slice(0, -2) removes last 2 chars, then appends "..."
    expect(formatBashCommand("some-command", 1)).toBe("some-comma...");
  });

  it("should truncate multi-segment command with very small width", () => {
    // Budget 3: each single-char segment fits within budget 3, so they pass through
    expect(formatBashCommand("a && b && c", 3)).toBe("a &&\n\u2502 b &&\n\u2502 c");
  });

  it("should return command unchanged when width exactly equals command length", () => {
    const cmd = "exact-length"; // 12 chars
    expect(formatBashCommand(cmd, cmd.length)).toBe(cmd);
  });

  it("should return multi-segment command unchanged when width exactly equals total length", () => {
    const cmd = "a && b && c"; // 11 chars
    expect(formatBashCommand(cmd, cmd.length)).toBe(cmd);
  });
});

describe("collapseCdDot", () => {
  it("should return '.' for exact cd to cwd", () => {
    expect(collapseCdDot("cd /home/user/project", "/home/user/project")).toBe(".");
  });

  it("should strip cd prefix when followed by && and command", () => {
    expect(collapseCdDot("cd /home/user/project && ls -la", "/home/user/project")).toBe("ls -la");
  });

  it("should return empty string for cd with trailing && and nothing after", () => {
    expect(collapseCdDot("cd /home/user/project &&", "/home/user/project")).toBe("");
  });

  it("should leave command unchanged when cd target differs from cwd", () => {
    expect(collapseCdDot("cd /other/path && ls", "/home/user/project")).toBe(
      "cd /other/path && ls",
    );
  });

  it("should leave command unchanged when not starting with cd", () => {
    expect(collapseCdDot("ls -la", "/home/user/project")).toBe("ls -la");
  });
});
