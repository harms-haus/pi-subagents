/**
 * Tests for src/profiles.ts — profileToArgs and security tests:
 * profileToArgs (argument building), extraArgs tool-override security,
 * profileToArgs with excludeTools, profileToArgs with suggestedSkills,
 * profileSummary with excludeTools/skills, formatProfileDetail with excludeTools/skills
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProfile } from "../profiles";
import {
  applyExcludeTools,
  formatProfileDetail,
  profileSummary,
  profileToArgs,
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
  stripFrontmatter: vi.fn((content: string) => content.replace(/^---[\s\S]*?---\n*/, "")),
  loadSkills: vi.fn(() => ({ skills: [], diagnostics: [] })),
}));

vi.mock("../skill-discovery", () => ({
  resolvePackageSkillPaths: vi.fn().mockResolvedValue([]),
}));



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

describe("profileToArgs extraArgs tool-override security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw when extraArgs contains --tools and tools is set", () => {
    const profile: SubagentProfile = {
      tools: ["read", "bash"],
      extraArgs: ["--tools", "write,delete"],
    };
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
