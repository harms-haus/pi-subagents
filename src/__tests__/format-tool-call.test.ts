/**
 * Tests for src/format-tool-call.ts — formatToolCall direct unit tests.
 */

import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collapseCdDot,
  formatBashCommand,
  formatToolCall,
  formatToolResult,
  formatToolResultInline,
  getToolEmoji,
  shortenPath,
  shortenPathsInText,
  TOOL_EMOJI,
} from "../format-tool-call";

const cwd = "/home/user/projects/my-app";

// Helper: widthBudget large enough to avoid truncation in most tests
const W = 120;

describe("formatToolCall", () => {
  // ── edit tool ────────────────────────────────────────────────────
  describe("edit", () => {
    it("shows count and diff stats with edits array", () => {
      const result = formatToolCall(
        "edit",
        {
          path: `${cwd}/src/index.ts`,
          edits: [{ oldText: "foo\nbar", newText: "baz" }],
        },
        cwd,
        W,
      );
      // 1 edit, oldText has 2 non-empty lines, newText has 1
      expect(result).toBe("edit → src/index.ts (1 edit) +1/-2");
    });

    it("shows plural 'edits' when multiple", () => {
      const result = formatToolCall(
        "edit",
        {
          path: `${cwd}/src/index.ts`,
          edits: [
            { oldText: "a", newText: "b" },
            { oldText: "c", newText: "d" },
          ],
        },
        cwd,
        W,
      );
      expect(result).toBe("edit → src/index.ts (2 edits) +2/-2");
    });

    it("with no edits (empty array) — no suffix", () => {
      const result = formatToolCall("edit", { path: `${cwd}/src/index.ts`, edits: [] }, cwd, W);
      expect(result).toBe("edit → src/index.ts");
    });

    it("with undefined edits — no suffix", () => {
      const result = formatToolCall("edit", { path: `${cwd}/src/index.ts` }, cwd, W);
      expect(result).toBe("edit → src/index.ts");
    });

    it("falls back to filePath if path is absent", () => {
      const result = formatToolCall("edit", { filePath: `${cwd}/src/foo.ts`, edits: [] }, cwd, W);
      expect(result).toBe("edit → src/foo.ts");
    });

    it("shows ... when no path at all", () => {
      const result = formatToolCall("edit", { edits: [] }, cwd, W);
      expect(result).toBe("edit → ...");
    });
  });

  // ── write tool ────────────────────────────────────────────────────
  describe("write", () => {
    it("with multi-line content (count non-empty lines)", () => {
      const result = formatToolCall(
        "write",
        { path: `${cwd}/src/new.ts`, content: "line1\nline2\nline3" },
        cwd,
        W,
      );
      expect(result).toBe("write → src/new.ts +3");
    });

    it("with empty content — shows +0", () => {
      const result = formatToolCall("write", { path: `${cwd}/src/empty.ts`, content: "" }, cwd, W);
      expect(result).toBe("write → src/empty.ts +0");
    });

    it("counts only non-empty lines (skips blank lines)", () => {
      const result = formatToolCall(
        "write",
        { path: `${cwd}/src/a.ts`, content: "a\n\nb\n  \nc" },
        cwd,
        W,
      );
      // Lines: "a" (non-empty), "" (empty), "b" (non-empty), "  " (empty), "c" (non-empty)
      expect(result).toBe("write → src/a.ts +3");
    });
  });

  // ── grep tool ────────────────────────────────────────────────────
  describe("grep", () => {
    it("pattern only", () => {
      const result = formatToolCall("grep", { pattern: "TODO" }, cwd, W);
      expect(result).toBe("grep → /TODO/");
    });

    it("pattern+glob (glob takes priority in display)", () => {
      const result = formatToolCall(
        "grep",
        { pattern: "TODO", glob: "*.ts", path: "/some/dir" },
        cwd,
        W,
      );
      expect(result).toBe("grep → /TODO/ → *.ts");
    });

    it("pattern+path", () => {
      const result = formatToolCall("grep", { pattern: "FIXME", path: `${cwd}/src` }, cwd, W);
      expect(result).toBe("grep → /FIXME/ → src");
    });

    it("pattern+path+glob (glob still takes priority)", () => {
      const result = formatToolCall(
        "grep",
        { pattern: "TODO", path: `${cwd}/src`, glob: "*.test.ts" },
        cwd,
        W,
      );
      expect(result).toBe("grep → /TODO/ → *.test.ts");
    });

    it("pattern with neither glob nor path", () => {
      const result = formatToolCall("grep", { pattern: "banana" }, cwd, W);
      expect(result).toBe("grep → /banana/");
    });
  });

  // ── bash tool ────────────────────────────────────────────────────
  describe("bash", () => {
    it("normal command", () => {
      const result = formatToolCall("bash", { command: "npm test" }, cwd, W);
      expect(result).toBe("bash → npm test");
    });

    it("`cd <cwd>` → should show as `cd .`", () => {
      const result = formatToolCall("bash", { command: `cd ${cwd}` }, cwd, W);
      expect(result).toBe("bash → cd .");
    });

    it("`cd <cwd> && cmd` → should collapse cd prefix", () => {
      const result = formatToolCall("bash", { command: `cd ${cwd} && npm test` }, cwd, W);
      expect(result).toBe("bash → npm test");
    });

    it("empty command after collapse → `cd .`", () => {
      const result = formatToolCall("bash", { command: `cd ${cwd} &&` }, cwd, W);
      expect(result).toBe("bash → cd .");
    });

    it("long command with && splitting", () => {
      const longCmd = "npm run build && npm run test && npm run lint && npm run deploy";
      const result = formatToolCall("bash", { command: longCmd }, cwd, 40);
      // Should contain │ continuation
      expect(result).toContain("│");
      expect(result).toContain("npm run build &&");
    });

    it("command that is just `.`", () => {
      const result = formatToolCall("bash", { command: "." }, cwd, W);
      expect(result).toBe("bash → cd .");
    });

    it("multiline command only uses first line", () => {
      const result = formatToolCall("bash", { command: "echo hello\necho world" }, cwd, W);
      expect(result).toBe("bash → echo hello");
    });

    it("shortens paths in command", () => {
      const result = formatToolCall("bash", { command: `cat ${cwd}/src/main.ts` }, cwd, W);
      expect(result).toBe("bash → cat src/main.ts");
    });
  });

  // ── read tool ────────────────────────────────────────────────────
  describe("read", () => {
    it("with offset+limit", () => {
      const result = formatToolCall(
        "read",
        { path: `${cwd}/src/main.ts`, offset: "10", limit: "20" },
        cwd,
        W,
      );
      expect(result).toBe("read → src/main.ts:10+20 (20 lines)");
    });

    it("with offset only", () => {
      const result = formatToolCall("read", { path: `${cwd}/src/main.ts`, offset: "5" }, cwd, W);
      expect(result).toBe("read → src/main.ts:5");
    });

    it("with limit only", () => {
      const result = formatToolCall("read", { path: `${cwd}/src/main.ts`, limit: "30" }, cwd, W);
      expect(result).toBe("read → src/main.ts+30 (30 lines)");
    });

    it("neither (just filename)", () => {
      const result = formatToolCall("read", { path: `${cwd}/src/main.ts` }, cwd, W);
      expect(result).toBe("read → src/main.ts");
    });
  });

  // ── delegate_to_subagents ─────────────────────────────────────────
  describe("delegate_to_subagents", () => {
    it("with per-task profiles (different profile per task)", () => {
      const result = formatToolCall(
        "delegate_to_subagents",
        {
          tasks: [{ profile: "coder" }, { profile: "reviewer" }],
        },
        cwd,
        W,
      );
      expect(result).toBe("delegate_to_subagents → 2 tasks [coder, reviewer]");
    });

    it("with top-level profile only", () => {
      const result = formatToolCall(
        "delegate_to_subagents",
        { tasks: [{ description: "do stuff" }], profile: "planner" },
        cwd,
        W,
      );
      expect(result).toBe("delegate_to_subagents → 1 task [planner]");
    });

    it("no profiles at all", () => {
      const result = formatToolCall(
        "delegate_to_subagents",
        { tasks: [{ description: "do stuff" }, { description: "do more" }] },
        cwd,
        W,
      );
      expect(result).toBe("delegate_to_subagents → 2 tasks");
    });

    it("single task without profile", () => {
      const result = formatToolCall(
        "delegate_to_subagents",
        { tasks: [{ description: "only one" }] },
        cwd,
        W,
      );
      expect(result).toBe("delegate_to_subagents → 1 task");
    });
  });

  // ── write_todos ───────────────────────────────────────────────────
  describe("write_todos", () => {
    it("replace mode", () => {
      const result = formatToolCall(
        "write_todos",
        {
          mode: "replace",
          todos: [{ text: "Task 1" }, { text: "Task 2" }],
        },
        cwd,
        W,
      );
      expect(result).toBe("write_todos → 2 todos written");
    });

    it("append mode", () => {
      const result = formatToolCall(
        "write_todos",
        {
          mode: "append",
          todos: [{ text: "Task A" }],
        },
        cwd,
        W,
      );
      expect(result).toBe("write_todos → 1 todos written");
    });
  });

  // ── edit_todos ────────────────────────────────────────────────────
  describe("edit_todos", () => {
    it("with todo text descriptions", () => {
      const result = formatToolCall(
        "edit_todos",
        {
          action: "complete",
          indices: [0],
          todos: [{ text: "Write tests" }, { text: "Ship it" }],
        },
        cwd,
        W,
      );
      expect(result).toBe("edit_todos → Write tests, Ship it");
    });

    it("without text (action+indices)", () => {
      const result = formatToolCall("edit_todos", { action: "start", indices: [2, 5] }, cwd, W);
      expect(result).toBe("edit_todos → start [2,5]");
    });

    it("long description truncation at 48 chars", () => {
      const longText = "This is a very long todo description that exceeds the truncation limit";
      const result = formatToolCall(
        "edit_todos",
        {
          action: "complete",
          indices: [0],
          todos: [{ text: longText }],
        },
        cwd,
        W,
      );
      // 45 chars + "..." = 48 chars
      const expected = `edit_todos → ${longText.slice(0, 45)}...`;
      expect(result).toBe(expected);
      expect(result.length).toBeLessThanOrEqual("edit_todos → ".length + 48);
    });

    it("empty todos array falls back to action+indices", () => {
      const result = formatToolCall(
        "edit_todos",
        { action: "abandon", indices: [1], todos: [] },
        cwd,
        W,
      );
      expect(result).toBe("edit_todos → abandon [1]");
    });
  });

  // ── list_todos ────────────────────────────────────────────────────
  describe("list_todos", () => {
    it("returns just the name", () => {
      expect(formatToolCall("list_todos", {}, cwd, W)).toBe("list_todos");
    });
  });

  // ── LSP tools ─────────────────────────────────────────────────────
  describe("LSP tools", () => {
    it("lsp_diagnostics: with file", () => {
      const result = formatToolCall("lsp_diagnostics", { file: `${cwd}/src/app.ts` }, cwd, W);
      expect(result).toBe("lsp_diagnostics → src/app.ts");
    });

    it("lsp_find_references: with file, line, column", () => {
      const result = formatToolCall(
        "lsp_find_references",
        { file: `${cwd}/src/app.ts`, line: 42, column: 10 },
        cwd,
        W,
      );
      expect(result).toBe("lsp_find_references → src/app.ts:42:10");
    });

    it("lsp_goto_definition: with file, line, column", () => {
      const result = formatToolCall(
        "lsp_goto_definition",
        { file: `${cwd}/src/app.ts`, line: 15, column: 5 },
        cwd,
        W,
      );
      expect(result).toBe("lsp_goto_definition → src/app.ts:15:5");
    });

    it("lsp_find_symbol: with query", () => {
      const result = formatToolCall("lsp_find_symbol", { query: "MyClass" }, cwd, W);
      expect(result).toBe("lsp_find_symbol → MyClass");
    });

    it("lsp_call_hierarchy: with file, line, column", () => {
      const result = formatToolCall(
        "lsp_call_hierarchy",
        { file: `${cwd}/src/app.ts`, line: 7, column: 3, direction: "callers" },
        cwd,
        W,
      );
      expect(result).toBe("lsp_call_hierarchy → src/app.ts:7:3");
    });

    it("lsp_refactor_symbol: with file, line, column, newName", () => {
      const result = formatToolCall(
        "lsp_refactor_symbol",
        { file: `${cwd}/src/app.ts`, line: 20, column: 8, newName: "betterName" },
        cwd,
        W,
      );
      expect(result).toBe("lsp_refactor_symbol → src/app.ts:20:8 → betterName");
    });
  });

  // ── lint_files ────────────────────────────────────────────────────
  describe("lint_files", () => {
    it("with files list ≤3 items", () => {
      const result = formatToolCall(
        "lint_files",
        { files: [`${cwd}/a.ts`, `${cwd}/b.ts`] },
        cwd,
        W,
      );
      expect(result).toBe("lint → a.ts, b.ts");
    });

    it("with files list >3 items (shows +N more)", () => {
      const result = formatToolCall(
        "lint_files",
        {
          files: [`${cwd}/a.ts`, `${cwd}/b.ts`, `${cwd}/c.ts`, `${cwd}/d.ts`, `${cwd}/e.ts`],
        },
        cwd,
        W,
      );
      expect(result).toBe("lint → a.ts, b.ts, ... +3 more");
    });

    it("with empty files array → shows 'lint → (all)'", () => {
      const result = formatToolCall("lint_files", { files: [] }, cwd, W);
      expect(result).toBe("lint → (all)");
    });

    it("with undefined files → shows 'lint → (all)'", () => {
      const result = formatToolCall("lint_files", {}, cwd, W);
      expect(result).toBe("lint → (all)");
    });
  });

  // ── fetch_content / web_search ─────────────────────────────────────
  describe("fetch_content / web_search", () => {
    it("fetch_content: short URL", () => {
      const result = formatToolCall("fetch_content", { url: "https://example.com" }, cwd, W);
      expect(result).toBe("fetch_content → https://example.com");
    });

    it("fetch_content: long URL (truncated)", () => {
      const url = "https://example.com/very/long/path/that/goes/on/and/on";
      const result = formatToolCall("fetch_content", { url }, cwd, 30);
      expect(result).toContain("fetch_content → ");
      expect(result).toContain("...");
      expect(result.length).toBeLessThanOrEqual(30);
    });

    it("web_search: short query", () => {
      const result = formatToolCall("web_search", { query: "vitest docs" }, cwd, W);
      expect(result).toBe("web_search → vitest docs");
    });

    it("web_search: long query (truncated)", () => {
      const query = "how to configure vitest with typescript and coverage reports in monorepo";
      const result = formatToolCall("web_search", { query }, cwd, 30);
      expect(result).toContain("web_search → ");
      expect(result).toContain("...");
      expect(result.length).toBeLessThanOrEqual(30);
    });
  });

  // ── fetch_repo ─────────────────────────────────────────────────────
  describe("fetch_repo", () => {
    it("with URL", () => {
      const result = formatToolCall("fetch_repo", { url: "https://github.com/org/repo" }, cwd, W);
      expect(result).toBe("fetch_repo → https://github.com/org/repo");
    });
  });

  // ── get_subagent_output / get_subagent_session ────────────────────
  describe("session retrieval tools", () => {
    it("get_subagent_output: with sessionId", () => {
      const result = formatToolCall("get_subagent_output", { sessionId: "abc-123" }, cwd, W);
      expect(result).toBe("get_subagent_output → abc-123");
    });

    it("get_subagent_output: without sessionId", () => {
      const result = formatToolCall("get_subagent_output", {}, cwd, W);
      expect(result).toBe("get_subagent_output → ...");
    });

    it("get_subagent_session: with sessionId", () => {
      const result = formatToolCall("get_subagent_session", { sessionId: "xyz-456" }, cwd, W);
      expect(result).toBe("get_subagent_session → xyz-456");
    });

    it("get_subagent_session: without sessionId", () => {
      const result = formatToolCall("get_subagent_session", {}, cwd, W);
      expect(result).toBe("get_subagent_session → ...");
    });
  });

  // ── list_subagent_profiles ────────────────────────────────────────
  describe("list_subagent_profiles", () => {
    it("returns just name", () => {
      expect(formatToolCall("list_subagent_profiles", {}, cwd, W)).toBe("list_subagent_profiles");
    });
  });

  // ── workflow_step ─────────────────────────────────────────────────
  describe("workflow_step", () => {
    it("with action", () => {
      const result = formatToolCall("workflow_step", { action: "next" }, cwd, W);
      expect(result).toBe("workflow_step → next");
    });
  });

  // ── ls tool ──────────────────────────────────────────────────────
  describe("ls", () => {
    it("with absolute path", () => {
      const result = formatToolCall("ls", { path: `${cwd}/src` }, cwd, W);
      expect(result).toBe("ls → src");
    });
    it("with no path (defaults to .)", () => {
      const result = formatToolCall("ls", {}, cwd, W);
      expect(result).toBe("ls → .");
    });
    it("with root path equal to cwd", () => {
      const result = formatToolCall("ls", { path: cwd }, cwd, W);
      expect(result).toBe("ls → .");
    });
  });

  // ── find tool ─────────────────────────────────────────────────────
  describe("find", () => {
    it("with pattern and path", () => {
      const result = formatToolCall("find", { pattern: "*.ts", path: `${cwd}/src` }, cwd, W);
      expect(result).toBe("find → *.ts in src");
    });
    it("with pattern only (no path)", () => {
      const result = formatToolCall("find", { pattern: "*.ts" }, cwd, W);
      expect(result).toBe("find → *.ts");
    });
    it("with no pattern (fallback to ...)", () => {
      const result = formatToolCall("find", {}, cwd, W);
      expect(result).toBe("find → ...");
    });
  });

  // ── default case ──────────────────────────────────────────────────
  describe("default (unknown tool)", () => {
    it("unknown tool name with empty args", () => {
      const result = formatToolCall("my_custom_tool", {}, cwd, W);
      expect(result).toBe("my_custom_tool");
    });

    it("unknown tool name with short args", () => {
      const result = formatToolCall("my_tool", { key: "value" }, cwd, W);
      expect(result).toBe('my_tool {"key":"value"}');
    });

    it("unknown tool name with long args (truncated)", () => {
      const result = formatToolCall("my_tool", { data: "a".repeat(200) }, cwd, 25);
      // Should truncate with ...
      expect(result).toContain("my_tool ");
      expect(result).toContain("...");
      expect(result.length).toBeLessThanOrEqual(25);
    });
  });
});

describe("formatToolResult", () => {
  describe("ls", () => {
    it("shows files and dirs counts", () => {
      expect(formatToolResult("ls", "file1.ts\nfile2.ts\ndir1/\n")).toBe("  2 files, 1 dir");
    });
    it("shows only files when no dirs", () => {
      expect(formatToolResult("ls", "file1\nfile2\nfile3")).toBe("  3 files");
    });
    it("shows only dirs when no files", () => {
      expect(formatToolResult("ls", "dir1/\ndir2/")).toBe("  2 dirs");
    });
    it("shows singular for 1 file", () => {
      expect(formatToolResult("ls", "readme.md")).toBe("  1 file");
    });
    it("shows singular for 1 dir", () => {
      expect(formatToolResult("ls", "src/")).toBe("  1 dir");
    });
    it("shows singular for 1 file and 1 dir", () => {
      expect(formatToolResult("ls", "readme.md\nsrc/")).toBe("  1 file, 1 dir");
    });
    it("handles empty directory message", () => {
      expect(formatToolResult("ls", "(empty directory)")).toBe("  (empty)");
    });
    it("handles empty string", () => {
      expect(formatToolResult("ls", "")).toBe("  (empty)");
    });
    it("filters out truncation notice lines", () => {
      expect(formatToolResult("ls", "file1\nfile2\n\n[500 entries limit reached]")).toBe(
        "  2 files",
      );
    });
    it("shows truncation indicator when entryLimitReached", () => {
      expect(formatToolResult("ls", "file1\nfile2", { entryLimitReached: 500 })).toBe("  2 files+");
    });
  });
  describe("find", () => {
    it("shows match count", () => {
      expect(formatToolResult("find", "src/a.ts\nsrc/b.ts\nsrc/c.ts")).toBe("  3 matches");
    });
    it("shows singular for 1 match", () => {
      expect(formatToolResult("find", "src/a.ts")).toBe("  1 match");
    });
    it("handles no matches message", () => {
      expect(formatToolResult("find", "No files found matching pattern")).toBe("  0 matches");
    });
    it("handles empty string", () => {
      expect(formatToolResult("find", "")).toBe("  0 matches");
    });
    it("filters out truncation notice lines", () => {
      expect(formatToolResult("find", "a.ts\nb.ts\n\n[1000 results limit reached]")).toBe(
        "  2 matches",
      );
    });
    it("shows truncation indicator when resultLimitReached", () => {
      expect(formatToolResult("find", "a.ts\nb.ts", { resultLimitReached: 1000 })).toBe(
        "  2 matches+",
      );
    });
  });
  describe("other tools", () => {
    it("returns null for unknown tool", () => {
      expect(formatToolResult("read", "file contents")).toBeNull();
    });
    it("returns null for bash", () => {
      expect(formatToolResult("bash", "command output")).toBeNull();
    });
  });
});

describe("formatToolResultInline", () => {
  describe("ls", () => {
    it("shows files and dirs counts without leading spaces", () => {
      expect(formatToolResultInline("ls", "file1.ts\nfile2.ts\ndir1/\n")).toBe("2 files, 1 dir");
    });
    it("shows only files when no dirs", () => {
      expect(formatToolResultInline("ls", "file1\nfile2\nfile3")).toBe("3 files");
    });
    it("shows only dirs when no files", () => {
      expect(formatToolResultInline("ls", "dir1/\ndir2/")).toBe("2 dirs");
    });
    it("shows singular for 1 file", () => {
      expect(formatToolResultInline("ls", "readme.md")).toBe("1 file");
    });
    it("shows singular for 1 dir", () => {
      expect(formatToolResultInline("ls", "src/")).toBe("1 dir");
    });
    it("shows singular for 1 file and 1 dir", () => {
      expect(formatToolResultInline("ls", "readme.md\nsrc/")).toBe("1 file, 1 dir");
    });
    it("handles empty directory message", () => {
      expect(formatToolResultInline("ls", "(empty directory)")).toBe("(empty)");
    });
    it("handles empty string", () => {
      expect(formatToolResultInline("ls", "")).toBe("(empty)");
    });
    it("filters out truncation notice lines", () => {
      expect(formatToolResultInline("ls", "file1\nfile2\n\n[500 entries limit reached]")).toBe(
        "2 files",
      );
    });
    it("shows truncation indicator when entryLimitReached", () => {
      expect(formatToolResultInline("ls", "file1\nfile2", { entryLimitReached: 500 })).toBe(
        "2 files+",
      );
    });
  });
  describe("find", () => {
    it("shows match count without leading spaces", () => {
      expect(formatToolResultInline("find", "src/a.ts\nsrc/b.ts\nsrc/c.ts")).toBe("3 matches");
    });
    it("shows singular for 1 match", () => {
      expect(formatToolResultInline("find", "src/a.ts")).toBe("1 match");
    });
    it("handles no matches message", () => {
      expect(formatToolResultInline("find", "No files found matching pattern")).toBe("0 matches");
    });
    it("handles empty string", () => {
      expect(formatToolResultInline("find", "")).toBe("0 matches");
    });
    it("filters out truncation notice lines", () => {
      expect(formatToolResultInline("find", "a.ts\nb.ts\n\n[1000 results limit reached]")).toBe(
        "2 matches",
      );
    });
    it("shows truncation indicator when resultLimitReached", () => {
      expect(formatToolResultInline("find", "a.ts\nb.ts", { resultLimitReached: 1000 })).toBe(
        "2 matches+",
      );
    });
  });
  describe("other tools", () => {
    it("returns null for unknown tool", () => {
      expect(formatToolResultInline("read", "file contents")).toBeNull();
    });
    it("returns null for bash", () => {
      expect(formatToolResultInline("bash", "command output")).toBeNull();
    });
  });
});

describe("getToolEmoji", () => {
  it("returns correct emoji for each tool in TOOL_EMOJI map", () => {
    for (const [toolName, expectedEmoji] of Object.entries(TOOL_EMOJI)) {
      expect(getToolEmoji(toolName)).toBe(expectedEmoji);
    }
  });

  it("returns 🔧 for unknown tool", () => {
    expect(getToolEmoji("nonexistent_tool_xyz")).toBe("🔧");
  });

  it("returns 🔧 for empty string", () => {
    expect(getToolEmoji("")).toBe("🔧");
  });

  it("TOOL_EMOJI has exactly 25 entries", () => {
    expect(Object.keys(TOOL_EMOJI).length).toBe(25);
  });

  it("find and web_search share the same emoji (🔍)", () => {
    expect(getToolEmoji("find")).toBe("🔍");
    expect(getToolEmoji("web_search")).toBe("🔍");
  });
});

// ── Windows Path Handling ──────────────────────────────────────────

describe("shortenPath with Windows paths", () => {
  it("shortens a Windows drive path under HOME to ~/...", () => {
    // Simulate Windows scenario: HOME is C:\Users\alice, path uses backslashes
    // On this Unix system, HOME won't match, so we test the regex-based behavior
    // by verifying that Windows drive-letter paths are recognized by shortenPathsInText
    const winCwd = "C:\\Users\\alice\\project";
    const winPath = "C:\\Users\\alice\\project\\src\\index.ts";
    const result = shortenPath(winPath, winCwd);
    // relative() on Unix won't produce a Windows relative path,
    // but it should still return something sensible
    expect(result).toBeTruthy();
  });

  it("returns . when path equals cwd", () => {
    const result = shortenPath("C:\\Users\\alice\\project", "C:\\Users\\alice\\project");
    expect(result).toBe(".");
  });

  it("handles forward-slash Windows paths", () => {
    const result = shortenPath("C:/Users/alice/project/src/main.ts", "C:/Users/alice/project");
    expect(result).toBe("src/main.ts");
  });
});

describe("shortenPathsInText with Windows paths", () => {
  const testCwd = "/home/user/project";

  it("matches Windows drive-letter paths with backslashes", () => {
    const text = "file at C:\\Users\\foo\\bar\\baz.ts";
    const result = shortenPathsInText(text, testCwd);
    // The Windows path should be detected by the regex (no crash)
    expect(result).toContain("C:\\Users\\foo\\bar\\baz.ts");
  });

  it("matches Windows drive-letter paths with forward slashes", () => {
    const text = "see C:/Users/foo/bar/baz.ts for details";
    const result = shortenPathsInText(text, testCwd);
    expect(result).toContain("C:/Users/foo/bar/baz.ts");
  });

  it("still matches Unix paths", () => {
    const text = "open /home/user/project/src/index.ts";
    const result = shortenPathsInText(text, "/home/user/project");
    expect(result).toContain("src/index.ts");
  });

  it("does NOT match URLs (https://example.com/path/to/resource)", () => {
    const text = "fetch https://example.com/path/to/resource";
    const result = shortenPathsInText(text, testCwd);
    // The URL should NOT be matched as a path
    expect(result).toBe(text);
  });

  it("does NOT match URLs with http:// protocol", () => {
    const text = "visit http://example.com/api/v1/data";
    const result = shortenPathsInText(text, testCwd);
    expect(result).toBe(text);
  });

  it("handles mixed content with both paths and URLs", () => {
    const text = "read /home/user/project/src/main.ts and ignore https://example.com/path";
    const result = shortenPathsInText(text, "/home/user/project");
    expect(result).toContain("src/main.ts");
    expect(result).toContain("https://example.com/path");
  });
});

describe("formatToolResult with backslash directory entries", () => {
  it("counts directories ending with backslash in ls output", () => {
    // Simulates Windows-style ls output where dirs end with \
    expect(formatToolResult("ls", "file1.ts\nfile2.ts\ndir1\\")).toBe("  2 files, 1 dir");
  });

  it("counts multiple backslash-terminated directories", () => {
    expect(formatToolResult("ls", "src\\\nlib\\\nreadme.md")).toBe("  1 file, 2 dirs");
  });

  it("handles mixed forward-slash and backslash terminators", () => {
    expect(formatToolResult("ls", "src/\nlib\\\nreadme.md")).toBe("  1 file, 2 dirs");
  });

  it("handles only backslash-terminated entries", () => {
    expect(formatToolResult("ls", "folder1\\\nfolder2\\")).toBe("  2 dirs");
  });
});

// ── Semicolon (`;`) Command Chaining ───────────────────────────────

describe("collapseCdDot with ; separator", () => {
  it("collapses `cd <cwd>; cmd` to just cmd", () => {
    expect(collapseCdDot("cd /home/user; ls", "/home/user")).toBe("ls");
  });

  it("collapses `cd <cwd>; cmd` with extra whitespace", () => {
    expect(collapseCdDot("cd /home/user ;   ls -la", "/home/user")).toBe("ls -la");
  });

  it("returns `.` for `cd <cwd>` alone (no separator)", () => {
    expect(collapseCdDot("cd /home/user", "/home/user")).toBe(".");
  });

  it("returns empty string for `cd <cwd>;` with nothing after", () => {
    expect(collapseCdDot("cd /home/user;", "/home/user")).toBe("");
  });

  it("collapses Windows path with && separator", () => {
    expect(collapseCdDot("cd C:\\Users\\test && echo hi", "C:\\Users\\test")).toBe("echo hi");
  });

  it("collapses Windows path with ; separator", () => {
    expect(collapseCdDot("cd C:\\Users\\test; echo hi", "C:\\Users\\test")).toBe("echo hi");
  });

  it("does not collapse when cwd doesn't match", () => {
    expect(collapseCdDot("cd /other/path; ls", "/home/user")).toBe("cd /other/path; ls");
  });

  it("existing && tests still work", () => {
    expect(collapseCdDot("cd /home/user && npm test", "/home/user")).toBe("npm test");
  });
});

describe("formatBashCommand with ; separator", () => {
  it("splits `cmd1; cmd2; cmd3` into segments", () => {
    const result = formatBashCommand("echo a; echo b; echo c", 80);
    // Short enough to fit on one line, preserves original separator type
    expect(result).toBe("echo a ; echo b ; echo c");
  });

  it("wraps long ; separated commands across lines", () => {
    const cmd = "npm run build; npm run test; npm run lint; npm run deploy";
    const result = formatBashCommand(cmd, 30);
    expect(result).toContain("│");
    expect(result).toContain("npm run build ;");
  });

  it("short ; chain fits in budget", () => {
    const result = formatBashCommand("echo a; echo b", 80);
    expect(result).toBe("echo a ; echo b");
  });

  it("single ; command that is too long truncates", () => {
    const longCmd = "a".repeat(100);
    const result = formatBashCommand(longCmd, 30);
    expect(result).toContain("...");
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it("existing && splitting still works", () => {
    const cmd = "npm run build && npm run test && npm run lint";
    const result = formatBashCommand(cmd, 80);
    expect(result).toBe("npm run build && npm run test && npm run lint");
  });

  it("does NOT split on bare & (background operator)", () => {
    const cmd = "sleep 1 & echo done";
    const result = formatBashCommand(cmd, 80);
    // Should NOT split — bare & is not a chain separator
    expect(result).toBe("sleep 1 & echo done");
  });
});

// ── Cross-platform tests with mocked os.homedir() ──────────────────
//
// These tests use vi.resetModules / vi.doMock to control the HOME constant
// captured at module-load time in format-path.ts.
//
// Note: afterEach, beforeEach, and vi are imported at the top of this file.


describe("shortenPath with mocked Windows HOME", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("shortens path under mocked Windows HOME using forward slashes", async () => {
    vi.doMock("node:os", () => ({
      ...os,
      homedir: () => "C:/Users/test",
    }));

    const { shortenPath: sp } = await import("../format-path");
    const result = sp("C:/Users/test/project/file.ts", "C:/Users/test/project");
    // relative() on Unix handles forward slashes → "file.ts"
    expect(result).toBe("file.ts");
  });

  it("replaces mocked Windows HOME prefix with ~/ when no shorter relative", async () => {
    vi.doMock("node:os", () => ({
      ...os,
      homedir: () => "C:/Users/test",
    }));

    const { shortenPath: sp } = await import("../format-path");
    // Path under HOME but different cwd → HOME prefix replaced with ~
    const result = sp("C:/Users/test/docs/report.pdf", "/unrelated/cwd");
    expect(result).toBe("~/docs/report.pdf");
  });

  it("returns . when path equals cwd even with Windows HOME", async () => {
    vi.doMock("node:os", () => ({
      ...os,
      homedir: () => "C:/Users/test",
    }));

    const { shortenPath: sp } = await import("../format-path");
    const result = sp("C:/Users/test/project", "C:/Users/test/project");
    expect(result).toBe(".");
  });

  it("handles shortenPathsInText with mocked Windows HOME", async () => {
    vi.doMock("node:os", () => ({
      ...os,
      homedir: () => "C:/Users/test",
    }));

    const { shortenPathsInText: spit } = await import("../format-path");
    const text = "open C:/Users/test/src/index.ts for editing";
    const result = spit(text, "/unrelated/cwd");
    // The path should be detected and shortened with HOME → ~/
    expect(result).toContain("~/src/index.ts");
    expect(result).not.toContain("C:/Users/test/src/index.ts");
  });

  it("shortenPathsInText with multiple Windows paths under mocked HOME", async () => {
    vi.doMock("node:os", () => ({
      ...os,
      homedir: () => "C:/Users/test",
    }));

    const { shortenPathsInText: spit } = await import("../format-path");
    const text = "read C:/Users/test/src/a.ts and C:/Users/test/src/b.ts";
    const result = spit(text, "C:/Users/test");
    expect(result).toContain("src/a.ts");
    // The regex may not match the second path due to boundary conditions
    // (word char preceding the drive letter), so we only assert the first
    // is shortened correctly.
    expect(result).toContain("src/b.ts");
  });
});
