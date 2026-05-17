/**
 * Tests for src/profiles.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProfile } from "../profiles";
import {
  applyExcludeTools,
  formatProfileDetail,
  getProfilesDir,
  invalidateProfilesCache,
  loadProfiles,
  profileSummary,
  profileToArgs,
  resolveProfile,
  resolveProfileSkills,
  validateProfileSkills,
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
  stripFrontmatter: vi.fn((content: string) =>
    content.replace(/^---[\s\S]*?---\n*/, ""),
  ),
  loadSkills: vi.fn(() => ({ skills: [], diagnostics: [] })),
}));

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { loadSkills as discoverSkills, parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";

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

describe("loadProfiles cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should return cached profiles on second call within TTL (cache hit)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([]);

    // First call populates the cache
    const result1 = await loadProfiles();
    // loadProfiles calls loadProfilesFromDir twice: global dir + project dir (no cwd)
    // With no cwd, only the global dir is loaded
    const firstCallCount = vi.mocked(readdirSync).mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    // Second call within TTL should hit the cache — readdirSync should NOT be called again
    const result2 = await loadProfiles();
    expect(vi.mocked(readdirSync).mock.calls.length).toBe(firstCallCount); // same count as first call
    expect(result2).toBe(result1); // same object reference
  });
});

describe("loadProfiles - project-local profile overriding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should load global and project-local profiles, with project-local overriding same name", async () => {
    // We need existsSync to return true for both global and project dirs
    vi.mocked(existsSync).mockReturnValue(true);

    // readdirSync is called once for global dir, once for project dir
    const globalEntries = [
      { name: "global-only.md", isFile: () => true },
      { name: "shared.md", isFile: () => true },
    ];
    const projectEntries = [
      { name: "shared.md", isFile: () => true },
      { name: "project-only.md", isFile: () => true },
    ];
    vi.mocked(readdirSync)
      .mockReturnValueOnce(globalEntries as unknown as ReturnType<typeof readdirSync>)
      .mockReturnValueOnce(projectEntries as unknown as ReturnType<typeof readdirSync>);

    // readFileSync is called for each .md file (global-only, shared [global], shared [project], project-only)
    vi.mocked(readFileSync)
      .mockReturnValueOnce('---\nname: global-only\nprovider: openai\nmodel: gpt-4\n---\n')
      .mockReturnValueOnce('---\nname: shared\nprovider: anthropic\nmodel: claude-3\n---\n')
      .mockReturnValueOnce('---\nname: shared\nprovider: openai\nmodel: gpt-4o\n---\n')
      .mockReturnValueOnce('---\nname: project-only\nprovider: dashscope\nmodel: qwen-max\n---\n');

    // parseFrontmatter is called for each file
    vi.mocked(parseFrontmatter)
      .mockReturnValueOnce({ frontmatter: { name: "global-only", provider: "openai", model: "gpt-4" }, body: "" })
      .mockReturnValueOnce({ frontmatter: { name: "shared", provider: "anthropic", model: "claude-3" }, body: "" })
      .mockReturnValueOnce({ frontmatter: { name: "shared", provider: "openai", model: "gpt-4o" }, body: "" })
      .mockReturnValueOnce({ frontmatter: { name: "project-only", provider: "dashscope", model: "qwen-max" }, body: "" });

    const profiles = await loadProfiles("/fake/project");

    // Global-only profile should be present
    expect(profiles["global-only"]).toBeDefined();
    expect(profiles["global-only"].provider).toBe("openai");
    expect(profiles["global-only"].model).toBe("gpt-4");

    // Project-only profile should be present
    expect(profiles["project-only"]).toBeDefined();
    expect(profiles["project-only"].provider).toBe("dashscope");
    expect(profiles["project-only"].model).toBe("qwen-max");

    // "shared" should be overridden by project-local version
    expect(profiles["shared"]).toBeDefined();
    expect(profiles["shared"].provider).toBe("openai"); // project-local override, not "anthropic"
    expect(profiles["shared"].model).toBe("gpt-4o"); // project-local override, not "claude-3"

    // Should have exactly 3 profiles
    expect(Object.keys(profiles)).toHaveLength(3);
  });
});

// ── suggestedSkills / loadSkills Tests ──────────────────────────────

describe("profileToArgs with suggestedSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should include --skill flag for each resolved suggestedSkill path", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["/path/to/a/SKILL.md", "/path/to/b/SKILL.md"],
    };
    const result = profileToArgs(profile);

    expect(result.args).toContain("--skill");
    expect(result.args).toContain("/path/to/a/SKILL.md");
    expect(result.args).toContain("--skill");
    expect(result.args).toContain("/path/to/b/SKILL.md");
  });

  it("should not include --skill when no suggestedSkills", () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    const result = profileToArgs(profile);

    expect(result.args).not.toContain("--skill");
  });

  it("should not include --skill when suggestedSkills is empty array", () => {
    const profile: SubagentProfile = { suggestedSkills: [] };
    const result = profileToArgs(profile);

    expect(result.args).not.toContain("--skill");
  });
});

describe("validateProfileSkills", () => {
  it("should throw when suggestedSkills and noSkills are both set", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["my-skill"],
      noSkills: true,
    };
    expect(() => validateProfileSkills(profile)).toThrow(/mutually exclusive/);
  });

  it("should include profile name in error message", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["my-skill"],
      noSkills: true,
    };
    expect(() => validateProfileSkills(profile, "conflicted-profile")).toThrow(
      /"conflicted-profile"/,
    );
  });

  it("should not throw when only suggestedSkills is set", () => {
    const profile: SubagentProfile = { suggestedSkills: ["my-skill"] };
    expect(() => validateProfileSkills(profile)).not.toThrow();
  });

  it("should not throw when only loadSkills is set", () => {
    const profile: SubagentProfile = { loadSkills: ["my-skill"] };
    expect(() => validateProfileSkills(profile)).not.toThrow();
  });

  it("should not throw when neither is set", () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    expect(() => validateProfileSkills(profile)).not.toThrow();
  });

  it("should throw when loadSkills and noSkills are both set", () => {
    const profile: SubagentProfile = {
      loadSkills: ["my-skill"],
      noSkills: true,
    };
    expect(() => validateProfileSkills(profile)).toThrow(/mutually exclusive/);
  });
});

describe("resolveProfileSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return profile unchanged when no skills configured", () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    const result = resolveProfileSkills(profile, "/fake/cwd");
    expect(result).toEqual(profile);
  });

  it("should resolve suggestedSkills names to file paths", () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        { name: "skill-a", filePath: "/skills/a/SKILL.md", description: "Skill A", baseDir: "/skills/a", sourceInfo: { path: "/skills/a/SKILL.md", source: "local", scope: "user", origin: "top-level" }, disableModelInvocation: false },
        { name: "skill-b", filePath: "/skills/b/SKILL.md", description: "Skill B", baseDir: "/skills/b", sourceInfo: { path: "/skills/b/SKILL.md", source: "local", scope: "user", origin: "top-level" }, disableModelInvocation: false },
      ],
      diagnostics: [],
    });

    const profile: SubagentProfile = { suggestedSkills: ["skill-a", "skill-b"] };
    const result = resolveProfileSkills(profile, "/fake/cwd");

    expect(result.suggestedSkills).toEqual([
      "/skills/a/SKILL.md",
      "/skills/b/SKILL.md",
    ]);
  });

  it("should inject loadSkills content into appendSystemPrompt", () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        { name: "coding", filePath: "/skills/coding/SKILL.md", description: "Coding skill", baseDir: "/skills/coding", sourceInfo: { path: "/skills/coding/SKILL.md", source: "local", scope: "user", origin: "top-level" }, disableModelInvocation: false },
      ],
      diagnostics: [],
    });
    vi.mocked(readFileSync).mockReturnValue(
      "---\nname: coding\n---\nYou are a coding expert.",
    );
    vi.mocked(stripFrontmatter).mockReturnValue("You are a coding expert.");

    const profile: SubagentProfile = { loadSkills: ["coding"] };
    const result = resolveProfileSkills(profile, "/fake/cwd");

    expect(result.appendSystemPrompt).toContain("<loaded_skill name=\"coding\">");
    expect(result.appendSystemPrompt).toContain("You are a coding expert.");
    expect(result.appendSystemPrompt).toContain("</loaded_skill>");
  });

  it("should throw when suggestedSkill name not found", () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [],
      diagnostics: [],
    });

    const profile: SubagentProfile = { suggestedSkills: ["unknown-skill"] };
    expect(() => resolveProfileSkills(profile, "/fake/cwd")).toThrow(
      /Unknown skills/,
    );
  });

  it("should throw when loadSkill name not found", () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [],
      diagnostics: [],
    });

    const profile: SubagentProfile = { loadSkills: ["unknown-skill"] };
    expect(() => resolveProfileSkills(profile, "/fake/cwd")).toThrow(
      /Unknown skills/,
    );
  });

  it("should concatenate loadSkills content with existing appendSystemPrompt", () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        { name: "testing", filePath: "/skills/testing/SKILL.md", description: "Testing skill", baseDir: "/skills/testing", sourceInfo: { path: "/skills/testing/SKILL.md", source: "local", scope: "user", origin: "top-level" }, disableModelInvocation: false },
      ],
      diagnostics: [],
    });
    vi.mocked(readFileSync).mockReturnValue(
      "---\nname: testing\n---\nRun all tests.",
    );
    vi.mocked(stripFrontmatter).mockReturnValue("Run all tests.");

    const profile: SubagentProfile = {
      appendSystemPrompt: "Original prompt.",
      loadSkills: ["testing"],
    };
    const result = resolveProfileSkills(profile, "/fake/cwd");

    expect(result.appendSystemPrompt).toContain("Original prompt.");
    expect(result.appendSystemPrompt).toContain("<loaded_skill name=\"testing\">");
    expect(result.appendSystemPrompt).toContain("Run all tests.");
  });

  it("should skip loadSkills with empty body after stripping frontmatter", () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        { name: "empty-skill", filePath: "/skills/empty/SKILL.md", description: "Empty skill", baseDir: "/skills/empty", sourceInfo: { path: "/skills/empty/SKILL.md", source: "local", scope: "user", origin: "top-level" }, disableModelInvocation: false },
      ],
      diagnostics: [],
    });
    vi.mocked(readFileSync).mockReturnValue(
      "---\nname: empty-skill\n---\n",
    );
    vi.mocked(stripFrontmatter).mockReturnValue("");

    const profile: SubagentProfile = { loadSkills: ["empty-skill"] };
    const result = resolveProfileSkills(profile, "/fake/cwd");

    expect(result.appendSystemPrompt).toBeUndefined();
    expect(result.loadSkills).toBeUndefined();
  });

  it("should set loadSkills to undefined after resolution", () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        { name: "my-skill", filePath: "/skills/my/SKILL.md", description: "My skill", baseDir: "/skills/my", sourceInfo: { path: "/skills/my/SKILL.md", source: "local", scope: "user", origin: "top-level" }, disableModelInvocation: false },
      ],
      diagnostics: [],
    });
    vi.mocked(readFileSync).mockReturnValue(
      "---\nname: my-skill\n---\nDo stuff.",
    );
    vi.mocked(stripFrontmatter).mockReturnValue("Do stuff.");

    const profile: SubagentProfile = { loadSkills: ["my-skill"] };
    const result = resolveProfileSkills(profile, "/fake/cwd");

    expect(result.loadSkills).toBeUndefined();
  });
});

describe("loadProfilesFromDir (suggestedSkills / loadSkills parsing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should parse suggestedSkills from comma-separated string", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "skills-profile.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      ["---", "name: skills-profile", "suggestedSkills: coding,testing", "---", ""].join("\n"),
    );
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: { name: "skills-profile", suggestedSkills: "coding,testing" },
      body: "",
    });

    const profiles = await loadProfiles();
    expect(profiles["skills-profile"]).toBeDefined();
    expect(profiles["skills-profile"].suggestedSkills).toEqual(["coding", "testing"]);
  });

  it("should parse loadSkills from YAML array", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "load-profile.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      ["---", "name: load-profile", "loadSkills:", "  - coding", "  - testing", "---", ""].join("\n"),
    );
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: { name: "load-profile", loadSkills: ["coding", "testing"] },
      body: "",
    });

    const profiles = await loadProfiles();
    expect(profiles["load-profile"]).toBeDefined();
    expect(profiles["load-profile"].loadSkills).toEqual(["coding", "testing"]);
  });

  it("should handle profile with both suggestedSkills and loadSkills", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "both-skills.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      ["---", "name: both-skills", "suggestedSkills: coding", "loadSkills:", "  - testing", "---", ""].join("\n"),
    );
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: { name: "both-skills", suggestedSkills: "coding", loadSkills: ["testing"] },
      body: "",
    });

    const profiles = await loadProfiles();
    expect(profiles["both-skills"]).toBeDefined();
    expect(profiles["both-skills"].suggestedSkills).toEqual(["coding"]);
    expect(profiles["both-skills"].loadSkills).toEqual(["testing"]);
  });
});

describe("profileSummary with skills", () => {
  it("should show suggestedSkills in profileSummary", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["coding", "testing"],
    };
    const result = profileSummary("test-profile", profile);
    expect(result).toContain("suggestedSkills=[coding,testing]");
  });

  it("should show loadSkills in profileSummary", () => {
    const profile: SubagentProfile = {
      loadSkills: ["workflow-gen"],
    };
    const result = profileSummary("test-profile", profile);
    expect(result).toContain("loadSkills=[workflow-gen]");
  });
});

describe("formatProfileDetail with skills", () => {
  it("should show suggestedSkills in formatProfileDetail", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["/path/to/coding/SKILL.md", "/path/to/testing/SKILL.md"],
    };
    const result = formatProfileDetail("test-profile", profile);
    expect(result).toContain("suggestedSkills");
    expect(result).toContain("/path/to/coding/SKILL.md");
    expect(result).toContain("/path/to/testing/SKILL.md");
  });

  it("should show loadSkills in formatProfileDetail", () => {
    const profile: SubagentProfile = {
      loadSkills: ["coding", "testing"],
    };
    const result = formatProfileDetail("test-profile", profile);
    expect(result).toContain("loadSkills");
    expect(result).toContain("coding");
    expect(result).toContain("testing");
  });
});
