/**
 * Tests for src/profiles.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProfile } from "../profiles";
import {
  formatProfileDetail,
  getSettingsPath,
  invalidateProfilesCache,
  loadMaxLinesPerWindow,
  profileSummary,
  profileToArgs,
  resolveProfile,
} from "../profiles";

// Mock filesystem functions
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

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

describe("getSettingsPath", () => {
  it("should return global path when scope is 'global'", () => {
    const result = getSettingsPath("global");

    expect(result).toMatch(/\.pi\/agent\/settings\.json$/);
  });

  it("should return project path when scope is 'project'", () => {
    const cwd = "/my/project";
    const result = getSettingsPath("project", cwd);

    expect(result).toBe("/my/project/.pi/settings.json");
  });

  it("should use process.cwd() when scope is 'project' and cwd is not provided", () => {
    const originalCwd = process.cwd();
    const result = getSettingsPath("project");

    expect(result).toBe(`${originalCwd}/.pi/settings.json`);
  });
});
