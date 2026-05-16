/**
 * Tests for src/settings.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadCommandPreviewWidth,
  loadMaxLinesPerWindow,
} from "../settings";

// Mock filesystem functions
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

describe("loadMaxLinesPerWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return default 15 when no config is present", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFile).mockRejectedValue(new Error("File not found"));

    const result = await loadMaxLinesPerWindow();

    expect(result).toBe(15);
  });

  it("should return configured value from settings", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
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
    vi.mocked(existsSync).mockReturnValue(true);
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
    vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
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
    vi.mocked(existsSync).mockReturnValue(false);
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
    vi.mocked(existsSync).mockReturnValue(true);
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
    vi.mocked(existsSync).mockReturnValue(true);
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
    vi.mocked(existsSync).mockReturnValue(true);
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
    vi.mocked(existsSync).mockReturnValue(true);
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
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("not json at all");

    const result = await loadCommandPreviewWidth();

    expect(result).toBe(160);
    expect(console.warn).toHaveBeenCalled();
  });
});
