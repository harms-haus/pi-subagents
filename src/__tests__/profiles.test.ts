/**
 * Tests for src/profiles.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProfile } from "../profiles";
import {
  applyExcludeTools,
  formatProfileDetail,
  getProfilesDir,
  invalidateProfilesCache,
  loadCommandPreviewWidth,
  loadMaxLinesPerWindow,
  loadProfiles,
  profileSummary,
  profileToArgs,
  resolveProfile,
  validateProfileTools,
} from "../profiles";

// Mock filesystem functions
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  parseFrontmatter: vi.fn(),
}));

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

describe("profileToArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should include --provider flag when provider is set", () => {
    const profile: SubagentProfile = { provider: "anthropic" };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--provider");
    expect(result.args).toContain("anthropic");
  });

  it("should include --model flag when model is set", () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--model");
    expect(result.args).toContain("anthropic/claude-sonnet-4");
  });

  it("should include --system-prompt flag when systemPrompt is set", () => {
    const profile: SubagentProfile = { systemPrompt: "You are a helpful assistant." };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--system-prompt");
    expect(result.args).toContain("You are a helpful assistant.");
  });

  it("should include --thinking flag when thinkingLevel is set", () => {
    const profile: SubagentProfile = { thinkingLevel: "high" };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--thinking");
    expect(result.args).toContain("high");
  });

  it("should include --tool flag for each tool in tools array", () => {
    const profile: SubagentProfile = { tools: ["read", "bash", "grep"] };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--tools");
    expect(result.args).toContain("read,bash,grep");
  });

  it("should include --extension flag for each extension", () => {
    const profile: SubagentProfile = { extensions: ["/path/to/ext1.js", "/path/to/ext2.js"] };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--extension");
    expect(result.args).toContain("/path/to/ext1.js");
    expect(result.args).toContain("--extension");
    expect(result.args).toContain("/path/to/ext2.js");
  });

  it("should set PI_API_KEY environment variable, not include in args", () => {
    const profile: SubagentProfile = { apiKey: "sk-secret-key-123" };
    const result = profileToArgs(profile);

    expect(result.args).not.toContain("--api-key");
    expect(result.args).not.toContain("sk-secret-key-123");
    expect(result.env.PI_API_KEY).toBe("sk-secret-key-123");
  });

  it("should append valid extraArgs to args", () => {
    const profile: SubagentProfile = { extraArgs: ["--verbose", "--timeout", "30"] };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--verbose");
    expect(result.args).toContain("--timeout");
    expect(result.args).toContain("30");
  });

  it("should throw error when extraArgs contains null byte", () => {
    const profile: SubagentProfile = { extraArgs: ["test\0arg"] };

    expect(() => profileToArgs(profile)).toThrow("Invalid extraArg: contains null byte");
  });

  it("should throw error when extraArgs contains shell operators", () => {
    const profile: SubagentProfile = { extraArgs: ["test && rm -rf /"] };

    expect(() => profileToArgs(profile)).toThrow("Refusing extraArg: potentially unsafe argument");
  });

  it("should throw error when extraArgs contains command separators", () => {
    const profile: SubagentProfile = { extraArgs: ["test; ls"] };

    expect(() => profileToArgs(profile)).toThrow("Refusing extraArg: potentially unsafe argument");
  });

  it("should return empty args and env for empty profile", () => {
    const profile: SubagentProfile = {};
    const result = profileToArgs(profile);

    expect(result.args).toEqual([]);
    expect(result.env).toEqual({});
  });

  it("should include all fields when profile has all fields set", () => {
    const profile: SubagentProfile = {
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4",
      systemPrompt: "Custom system prompt",
      thinkingLevel: "medium",
      tools: ["read", "bash"],
      extensions: ["/ext.js"],
      noTools: false,
      noExtensions: false,
      noSkills: false,
      noContextFiles: false,
      extraArgs: ["--verbose"],
    };

    const result = profileToArgs(profile);

    expect(result.args).toContain("--provider");
    expect(result.args).toContain("anthropic");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("anthropic/claude-sonnet-4");
    expect(result.args).toContain("--system-prompt");
    expect(result.args).toContain("Custom system prompt");
    expect(result.args).toContain("--thinking");
    expect(result.args).toContain("medium");
    expect(result.args).toContain("--tools");
    expect(result.args).toContain("read,bash");
    expect(result.args).toContain("--extension");
    expect(result.args).toContain("/ext.js");
    expect(result.args).toContain("--verbose");
  });

  it("should include --no-tools flag when noTools is true", () => {
    const profile: SubagentProfile = { noTools: true };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--no-tools");
  });

  it("should include --no-extensions flag when noExtensions is true", () => {
    const profile: SubagentProfile = { noExtensions: true };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--no-extensions");
  });

  it("should include --no-skills flag when noSkills is true", () => {
    const profile: SubagentProfile = { noSkills: true };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--no-skills");
  });

  it("should include --no-context-files flag when noContextFiles is true", () => {
    const profile: SubagentProfile = { noContextFiles: true };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--no-context-files");
  });

  it("should include --append-system-prompt flag when appendSystemPrompt is set", () => {
    const profile: SubagentProfile = { appendSystemPrompt: "Additional instructions" };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--append-system-prompt");
    expect(result.args).toContain("Additional instructions");
  });
});

describe("resolveProfile", () => {
  it("should return profile when profile name exists", () => {
    const profiles = {
      "code-reviewer": {
        model: "anthropic/claude-sonnet-4",
        systemPrompt: "You are a code reviewer.",
      },
      "fast-worker": {
        model: "openai/gpt-4o",
      },
    };

    const result = resolveProfile(profiles, "code-reviewer");

    expect(result).toEqual(profiles["code-reviewer"]);
  });

  it("should return undefined when profile name does not exist", () => {
    const profiles = {
      "code-reviewer": {
        model: "anthropic/claude-sonnet-4",
      },
    };

    const result = resolveProfile(profiles, "non-existent");

    expect(result).toBeUndefined();
  });
});

describe("profileSummary", () => {
  it("should show model when profile has model", () => {
    const profile: SubagentProfile = {
      model: "anthropic/claude-sonnet-4",
      thinkingLevel: "high",
    };

    const result = profileSummary("test-profile", profile);

    expect(result).toContain("profile: test-profile");
    expect(result).toContain("model=anthropic/claude-sonnet-4");
    expect(result).toContain("thinking=high");
  });

  it("should show provider when profile has provider but no model", () => {
    const profile: SubagentProfile = {
      provider: "openai",
    };

    const result = profileSummary("test-profile", profile);

    expect(result).toContain("profile: test-profile");
    expect(result).toContain("provider=openai");
    expect(result).not.toContain("model=");
  });

  it("should show default when profile has neither model nor provider", () => {
    const profile: SubagentProfile = {
      systemPrompt: "Custom prompt",
    };

    const result = profileSummary("test-profile", profile);

    expect(result).toContain("profile: test-profile");
    expect(result).not.toContain("model=");
    expect(result).not.toContain("provider=");
  });

  it("should show custom-system-prompt when systemPrompt is set", () => {
    const profile: SubagentProfile = {
      systemPrompt: "You are a custom assistant.",
    };

    const result = profileSummary("test-profile", profile);

    expect(result).toContain("custom-system-prompt");
  });

  it("should show appended-system-prompt when appendSystemPrompt is set", () => {
    const profile: SubagentProfile = {
      appendSystemPrompt: "Be concise.",
    };

    const result = profileSummary("test-profile", profile);

    expect(result).toContain("appended-system-prompt");
  });

  it("should show no-tools when noTools is true", () => {
    const profile: SubagentProfile = {
      noTools: true,
    };

    const result = profileSummary("test-profile", profile);

    expect(result).toContain("no-tools");
  });

  it("should show tools array when tools is set", () => {
    const profile: SubagentProfile = {
      tools: ["read", "bash", "grep"],
    };

    const result = profileSummary("test-profile", profile);

    expect(result).toContain("tools=[read,bash,grep]");
  });
});

describe("formatProfileDetail", () => {
  it("should mask API key and not show full key", () => {
    const profile: SubagentProfile = {
      model: "anthropic/claude-sonnet-4",
      apiKey: "sk-1234567890abcdef",
    };

    const result = formatProfileDetail("test-profile", profile);

    expect(result).toContain("Profile: test-profile");
    expect(result).toContain("model:             anthropic/claude-sonnet-4");
    expect(result).not.toContain("sk-1234567890abcdef");
    expect(result).toContain("sk-1");
    expect(result).toContain("****");
  });

  it("should show all fields when profile has all fields set", () => {
    const profile: SubagentProfile = {
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4",
      thinkingLevel: "high",
      systemPrompt: "Custom system prompt",
      appendSystemPrompt: "Additional instructions",
      noTools: false,
      tools: ["read", "bash"],
      noExtensions: false,
      extensions: ["/ext.js"],
      noSkills: false,
      noContextFiles: false,
      apiKey: "sk-test123",
      extraArgs: ["--verbose"],
    };

    const result = formatProfileDetail("full-profile", profile);

    expect(result).toContain("Profile: full-profile");
    expect(result).toContain("provider:          anthropic");
    expect(result).toContain("model:             anthropic/claude-sonnet-4");
    expect(result).toContain("thinkingLevel:     high");
    expect(result).toContain("systemPrompt:      Custom system prompt");
    expect(result).toContain("appendSystemPrompt: Additional instructions");
    expect(result).toContain("tools:             [read, bash]");
    expect(result).toContain("extensions:        [/ext.js]");
    expect(result).toContain("apiKey:");
    expect(result).toContain("extraArgs:");
  });

  it("should show only set fields when profile has minimal fields", () => {
    const profile: SubagentProfile = {
      model: "anthropic/claude-sonnet-4",
      thinkingLevel: "medium",
    };

    const result = formatProfileDetail("minimal-profile", profile);

    expect(result).toContain("Profile: minimal-profile");
    expect(result).toContain("model:             anthropic/claude-sonnet-4");
    expect(result).toContain("thinkingLevel:     medium");
    expect(result).not.toContain("provider:");
    expect(result).not.toContain("systemPrompt:");
    expect(result).not.toContain("apiKey:");
  });

  it("should mask short API key with all asterisks", () => {
    const profile: SubagentProfile = {
      apiKey: "sk-12",
    };

    const result = formatProfileDetail("test-profile", profile);

    expect(result).toContain("****");
    expect(result).not.toContain("sk-12");
  });

  it("should show noTools: true when noTools is true", () => {
    const profile: SubagentProfile = {
      noTools: true,
    };

    const result = formatProfileDetail("test-profile", profile);

    expect(result).toContain("noTools:           true");
  });

  it("should show noExtensions: true when noExtensions is true", () => {
    const profile: SubagentProfile = {
      noExtensions: true,
    };

    const result = formatProfileDetail("test-profile", profile);

    expect(result).toContain("noExtensions:      true");
  });

  it("should show noSkills: true when noSkills is true", () => {
    const profile: SubagentProfile = {
      noSkills: true,
    };

    const result = formatProfileDetail("test-profile", profile);

    expect(result).toContain("noSkills:          true");
  });

  it("should show noContextFiles: true when noContextFiles is true", () => {
    const profile: SubagentProfile = {
      noContextFiles: true,
    };

    const result = formatProfileDetail("test-profile", profile);

    expect(result).toContain("noContextFiles:    true");
  });
});

describe("loadMaxLinesPerWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
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
    invalidateProfilesCache();
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

describe("getProfilesDir", () => {
  it("should return global agent-profiles dir when scope is 'global'", () => {
    const result = getProfilesDir("global");
    expect(result).toMatch(/\.pi\/agent\/agent-profiles$/);
  });

  it("should return project agent-profiles dir when scope is 'project'", () => {
    const cwd = "/my/project";
    const result = getProfilesDir("project", cwd);
    expect(result).toBe("/my/project/.pi/agent-profiles");
  });

  it("should use process.cwd() when scope is 'project' and cwd is not provided", () => {
    const originalCwd = process.cwd();
    const result = getProfilesDir("project");
    expect(result).toBe(`${originalCwd}/.pi/agent-profiles`);
  });
});

describe("validateProfileTools", () => {
  it("should not throw when only tools is set", () => {
    const profile: SubagentProfile = { tools: ["read", "bash"] };
    expect(() => validateProfileTools(profile)).not.toThrow();
  });

  it("should not throw when only excludeTools is set", () => {
    const profile: SubagentProfile = { excludeTools: ["write", "bash"] };
    expect(() => validateProfileTools(profile)).not.toThrow();
  });

  it("should throw error when both tools and excludeTools are set", () => {
    const profile: SubagentProfile = { tools: ["read"], excludeTools: ["write"] };
    expect(() => validateProfileTools(profile)).toThrow(/mutually exclusive/);
  });

  it("should include profile name in error when both are set", () => {
    const profile: SubagentProfile = { tools: ["read"], excludeTools: ["write"] };
    expect(() => validateProfileTools(profile, "my-profile")).toThrow(/"my-profile"/);
  });

  it("should not throw when neither tools nor excludeTools is set", () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    expect(() => validateProfileTools(profile)).not.toThrow();
  });
});

describe("applyExcludeTools", () => {
  it("should return unchanged profile when no excludeTools", () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    const result = applyExcludeTools(profile, ["read", "bash", "write"]);
    expect(result).toEqual(profile);
  });

  it("should filter out excluded tools from allToolNames", () => {
    const profile: SubagentProfile = { excludeTools: ["bash", "write"] };
    const result = applyExcludeTools(profile, ["read", "bash", "write", "grep"]);
    expect(result.tools).toEqual(["read", "grep"]);
  });

  it("should return profile with computed tools and excludeTools removed", () => {
    const profile: SubagentProfile = { excludeTools: ["bash"], model: "anthropic/claude-sonnet-4" };
    const result = applyExcludeTools(profile, ["read", "bash", "write"]);
    expect(result.tools).toEqual(["read", "write"]);
    expect(result.excludeTools).toBeUndefined();
    expect(result.model).toBe("anthropic/claude-sonnet-4");
  });

  it("should handle empty excludeTools array", () => {
    const profile: SubagentProfile = { excludeTools: [] };
    const result = applyExcludeTools(profile, ["read", "bash"]);
    expect(result).toEqual(profile);
  });
});

describe("profileToArgs extraArgs tool-override security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw when extraArgs contains --tools and tools is set", () => {
    const profile: SubagentProfile = { tools: ["read", "bash"], extraArgs: ["--tools", "write,delete"] };
    expect(() => profileToArgs(profile)).toThrow(
      /Refusing extraArg "--tools" which would override profile tool restrictions/,
    );
  });

  it("should throw when extraArgs contains --tools and excludeTools is set", () => {
    const profile: SubagentProfile = { excludeTools: ["bash"], extraArgs: ["--tools", "all"] };
    expect(() => profileToArgs(profile)).toThrow(
      /Refusing extraArg "--tools" which would override profile tool restrictions/,
    );
  });

  it("should throw when extraArgs contains --no-tools and tools is set", () => {
    const profile: SubagentProfile = { tools: ["read"], extraArgs: ["--no-tools"] };
    expect(() => profileToArgs(profile)).toThrow(
      /Refusing extraArg "--no-tools" which would override profile tool restrictions/,
    );
  });

  it("should throw when extraArgs contains -t and tools is set", () => {
    const profile: SubagentProfile = { tools: ["read"], extraArgs: ["-t", "all"] };
    expect(() => profileToArgs(profile)).toThrow(
      /Refusing extraArg "-t" which would override profile tool restrictions/,
    );
  });

  it("should throw when extraArgs contains -nt and excludeTools is set", () => {
    const profile: SubagentProfile = { excludeTools: ["bash"], extraArgs: ["-nt"] };
    expect(() => profileToArgs(profile)).toThrow(
      /Refusing extraArg "-nt" which would override profile tool restrictions/,
    );
  });

  it("should throw when extraArgs contains --tools and noTools is true", () => {
    const profile: SubagentProfile = { noTools: true, extraArgs: ["--tools", "bash"] };
    expect(() => profileToArgs(profile)).toThrow(/Refusing extraArg/);
  });

  it("should throw when extraArgs contains --no-tools and noTools is true", () => {
    const profile: SubagentProfile = { noTools: true, extraArgs: ["--no-tools"] };
    expect(() => profileToArgs(profile)).toThrow(/Refusing extraArg/);
  });

  it("should throw when extraArgs contains --tools=value equals-sign form and tools is set", () => {
    const profile: SubagentProfile = { tools: ["read", "bash"], extraArgs: ["--tools=bash,write"] };
    expect(() => profileToArgs(profile)).toThrow(
      /Refusing extraArg "--tools=bash,write" which would override profile tool restrictions/,
    );
  });

  it("should throw when extraArgs contains --no-tools=value equals-sign form and noTools is true", () => {
    const profile: SubagentProfile = { noTools: true, extraArgs: ["--no-tools=read"] };
    expect(() => profileToArgs(profile)).toThrow(
      /Refusing extraArg "--no-tools=read" which would override profile tool restrictions/,
    );
  });

  it("should allow --tools in extraArgs when no tool restrictions are active", () => {
    const profile: SubagentProfile = { extraArgs: ["--tools", "read,bash"] };
    const result = profileToArgs(profile);
    expect(result.args).toContain("--tools");
    expect(result.args).toContain("read,bash");
  });

  it("should allow extraArgs without tool flags when tools is set", () => {
    const profile: SubagentProfile = { tools: ["read"], extraArgs: ["--verbose"] };
    const result = profileToArgs(profile);
    expect(result.args).toContain("--tools");
    expect(result.args).toContain("read");
    expect(result.args).toContain("--verbose");
  });
});

describe("profileToArgs with excludeTools", () => {
  it("should NOT add --tools when only excludeTools is set (unresolved)", () => {
    const profile: SubagentProfile = { excludeTools: ["bash"] };
    const result = profileToArgs(profile);
    expect(result.args).not.toContain("--tools");
  });

  it("should pass computed tools as --tools after applyExcludeTools", () => {
    const profile: SubagentProfile = { excludeTools: ["bash", "write"] };
    const resolved = applyExcludeTools(profile, ["read", "bash", "write", "grep"]);
    const result = profileToArgs(resolved);
    expect(result.args).toContain("--tools");
    expect(result.args).toContain("read,grep");
  });
});

describe("profileSummary with excludeTools", () => {
  it("should show excludeTools in summary", () => {
    const profile: SubagentProfile = { excludeTools: ["bash", "write"] };
    const result = profileSummary("test-profile", profile);
    expect(result).toContain("excludeTools=[bash,write]");
  });
});

describe("formatProfileDetail with excludeTools", () => {
  it("should show excludeTools in detail view", () => {
    const profile: SubagentProfile = { excludeTools: ["bash", "write"] };
    const result = formatProfileDetail("test-profile", profile);
    expect(result).toContain("excludeTools:      [bash, write]");
  });
});

describe("loadProfilesFromDir (excludeTools parsing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should parse excludeTools from comma-separated string", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([{ name: "string-exclude.md", isFile: () => true }] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      ["---", "name: string-exclude", "excludeTools: bash,write", "---", ""].join("\n"),
    );
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: { name: "string-exclude", excludeTools: "bash,write" },
      body: "",
    });

    const profiles = await loadProfiles();
    expect(profiles["string-exclude"]).toBeDefined();
    expect(profiles["string-exclude"].excludeTools).toEqual(["bash", "write"]);
  });

  it("should parse excludeTools from YAML array", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([{ name: "array-exclude.md", isFile: () => true }] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      ["---", "name: array-exclude", "excludeTools:", "  - bash", "  - write", "---", ""].join("\n"),
    );
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: { name: "array-exclude", excludeTools: ["bash", "write"] },
      body: "",
    });

    const profiles = await loadProfiles();
    expect(profiles["array-exclude"]).toBeDefined();
    expect(profiles["array-exclude"].excludeTools).toEqual(["bash", "write"]);
  });
});
