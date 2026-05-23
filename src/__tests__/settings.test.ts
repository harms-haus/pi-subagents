/**
 * Tests for src/settings.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadCommandPreviewWidth,
  loadExtendTimeoutDebounce,
  loadLoopingToolCount,
  loadMaxLinesPerWindow,
} from "../settings";

// Mock filesystem functions
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";

describe("loadMaxLinesPerWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return default 15 when no config is present", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("File not found"));

    const result = await loadMaxLinesPerWindow();

    expect(result).toBe(15);
  });

  it("should return configured value from settings", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          maxLinesPerWindow: 25,
        },
      }),
    );

    const result = await loadMaxLinesPerWindow();

    expect(result).toBe(25);
  });

  it("should return project config value when both global and project config exist", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            maxLinesPerWindow: 20,
          },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            maxLinesPerWindow: 30,
          },
        }),
      );

    const result = await loadMaxLinesPerWindow("/project/path");

    expect(result).toBe(30);
  });

  it("should return global config value when only global config exists", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            maxLinesPerWindow: 20,
          },
        }),
      )
      .mockRejectedValueOnce(new Error("Project file not found"));

    const result = await loadMaxLinesPerWindow("/project/path");

    expect(result).toBe(20);
  });
});

describe("loadCommandPreviewWidth", () => {
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Restore original process.stdout.columns to avoid test pollution
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      writable: true,
      configurable: true,
    });
  });

  it("returns terminal width - 4 when TTY", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 120,
      writable: true,
      configurable: true,
    });

    const result = await loadCommandPreviewWidth();

    expect(result).toBe(116);
  });

  it("returns default 160 when non-TTY and no settings", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    vi.mocked(readFile).mockRejectedValue(new Error("File not found"));

    const result = await loadCommandPreviewWidth();

    expect(result).toBe(160);
  });

  it("returns configured value from global settings when non-TTY", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          commandPreviewWidth: 200,
        },
      }),
    );

    const result = await loadCommandPreviewWidth();

    expect(result).toBe(200);
  });

  it("project overrides global when non-TTY", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            commandPreviewWidth: 200,
          },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            commandPreviewWidth: 120,
          },
        }),
      );

    const result = await loadCommandPreviewWidth("/project/path");

    expect(result).toBe(120);
  });

  it("user setting takes priority over TTY width", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 80,
      writable: true,
      configurable: true,
    });
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          commandPreviewWidth: 200,
        },
      }),
    );

    const result = await loadCommandPreviewWidth();

    expect(result).toBe(200);
  });

  it("clamps to min 20 when terminal is very narrow", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 15,
      writable: true,
      configurable: true,
    });

    const result = await loadCommandPreviewWidth();

    expect(result).toBe(20);
  });

  it("clamps to min 20 when setting is very small", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          commandPreviewWidth: 5,
        },
      }),
    );

    const result = await loadCommandPreviewWidth();

    expect(result).toBe(20);
  });
});

describe("readSettingsFile error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("should return default maxLinesPerWindow when settings file has malformed JSON", async () => {
    vi.mocked(readFile).mockResolvedValue("{ invalid json !!!");

    const result = await loadMaxLinesPerWindow();

    expect(result).toBe(15);
    expect(console.warn).toHaveBeenCalled();
  });

  it("should return default commandPreviewWidth when settings file has malformed JSON", async () => {
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    vi.mocked(readFile).mockResolvedValue("not json at all");

    const result = await loadCommandPreviewWidth();

    expect(result).toBe(160);
    expect(console.warn).toHaveBeenCalled();
  });

  it("should return default extendTimeoutDebounce when settings file has malformed JSON", async () => {
    vi.mocked(readFile).mockResolvedValue("{ invalid json !!!");

    const result = await loadExtendTimeoutDebounce();

    expect(result).toBe(30);
    expect(console.warn).toHaveBeenCalled();
  });

  it("should return default loopingToolCount when settings file has malformed JSON", async () => {
    vi.mocked(readFile).mockResolvedValue("{ invalid json !!!");

    const result = await loadLoopingToolCount();

    expect(result).toBe(5);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("loadExtendTimeoutDebounce", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should return default 30 when no config is present", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("File not found"));

    const result = await loadExtendTimeoutDebounce();

    expect(result).toBe(30);
  });

  it("should return configured value from global settings", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          extend_timeout_debounce: 60,
        },
      }),
    );

    const result = await loadExtendTimeoutDebounce();

    expect(result).toBe(60);
  });

  it("should prefer project config over global", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            extend_timeout_debounce: 45,
          },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            extend_timeout_debounce: 90,
          },
        }),
      );

    const result = await loadExtendTimeoutDebounce("/project/path");

    expect(result).toBe(90);
  });

  it("should return global config value when project has no config", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            extend_timeout_debounce: 45,
          },
        }),
      )
      .mockRejectedValueOnce(new Error("Project file not found"));

    const result = await loadExtendTimeoutDebounce("/project/path");

    expect(result).toBe(45);
  });

  it("should clamp value to max 300", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          extend_timeout_debounce: 999,
        },
      }),
    );

    const result = await loadExtendTimeoutDebounce();

    expect(result).toBe(300);
  });

  it("should clamp value to min 0", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          extend_timeout_debounce: -10,
        },
      }),
    );

    const result = await loadExtendTimeoutDebounce();

    expect(result).toBe(0);
  });

  it("should return default for non-number value", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          extend_timeout_debounce: "abc",
        },
      }),
    );

    const result = await loadExtendTimeoutDebounce();

    expect(result).toBe(30);
  });

  it("should return default for NaN value", async () => {
    // JSON.parse of 1e999 evaluates to Infinity in V8, which is not finite
    // This tests the !Number.isFinite(value) code path (same as NaN)
    vi.mocked(readFile).mockResolvedValue('{"subagents":{"extend_timeout_debounce":1e999}}');

    const result = await loadExtendTimeoutDebounce();

    expect(result).toBe(30);
  });
});

describe("loadLoopingToolCount", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should return default 5 when no config is present", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("File not found"));

    const result = await loadLoopingToolCount();

    expect(result).toBe(5);
  });

  it("should return configured value from global settings", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          looping_tool_count: 10,
        },
      }),
    );

    const result = await loadLoopingToolCount();

    expect(result).toBe(10);
  });

  it("should prefer project config over global", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            looping_tool_count: 10,
          },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            looping_tool_count: 3,
          },
        }),
      );

    const result = await loadLoopingToolCount("/project/path");

    expect(result).toBe(3);
  });

  it("should return global config value when project has no config", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          subagents: {
            looping_tool_count: 10,
          },
        }),
      )
      .mockRejectedValueOnce(new Error("Project file not found"));

    const result = await loadLoopingToolCount("/project/path");

    expect(result).toBe(10);
  });

  it("should clamp value to max 50", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          looping_tool_count: 100,
        },
      }),
    );

    const result = await loadLoopingToolCount();

    expect(result).toBe(50);
  });

  it("should clamp value to min 0", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          looping_tool_count: -5,
        },
      }),
    );

    const result = await loadLoopingToolCount();

    expect(result).toBe(0);
  });

  it("should return default for non-number value", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        subagents: {
          looping_tool_count: "not a number",
        },
      }),
    );

    const result = await loadLoopingToolCount();

    expect(result).toBe(5);
  });
});
