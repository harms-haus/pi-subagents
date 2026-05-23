/**
 * Tests for src/profiles.ts — Core profile functionality:
 * resolveProfile, profileSummary, formatProfileDetail, getProfilesDir,
 * validateProfileTools, applyExcludeTools, validateProfileSkills,
 * resolveProfileSkills, loadProfilesFromDir parsing, loadProfiles cache,
 * loadProfiles project-local profiles, apiKey security,
 * profileToArgs skill path validation
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
import { serializeProfileToMarkdown } from "../profile-formatting";

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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  loadSkills as discoverSkills,
  parseFrontmatter,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

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
    expect(() => {
      validateProfileTools(profile);
    }).not.toThrow();
  });

  it("should not throw when only excludeTools is set", () => {
    const profile: SubagentProfile = { excludeTools: ["write", "bash"] };
    expect(() => {
      validateProfileTools(profile);
    }).not.toThrow();
  });

  it("should throw error when both tools and excludeTools are set", () => {
    const profile: SubagentProfile = { tools: ["read"], excludeTools: ["write"] };
    expect(() => {
      validateProfileTools(profile);
    }).toThrow(/mutually exclusive/);
  });

  it("should include profile name in error when both are set", () => {
    const profile: SubagentProfile = { tools: ["read"], excludeTools: ["write"] };
    expect(() => {
      validateProfileTools(profile, "my-profile");
    }).toThrow(/"my-profile"/);
  });

  it("should not throw when neither tools nor excludeTools is set", () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    expect(() => {
      validateProfileTools(profile);
    }).not.toThrow();
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

describe("validateProfileSkills", () => {
  it("should throw when suggestedSkills and noSkills are both set", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["my-skill"],
      noSkills: true,
    };
    expect(() => {
      validateProfileSkills(profile);
    }).toThrow(/mutually exclusive/);
  });

  it("should include profile name in error message", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["my-skill"],
      noSkills: true,
    };
    expect(() => {
      validateProfileSkills(profile, "conflicted-profile");
    }).toThrow(/"conflicted-profile"/);
  });

  it("should not throw when only suggestedSkills is set", () => {
    const profile: SubagentProfile = { suggestedSkills: ["my-skill"] };
    expect(() => {
      validateProfileSkills(profile);
    }).not.toThrow();
  });

  it("should not throw when only loadSkills is set", () => {
    const profile: SubagentProfile = { loadSkills: ["my-skill"] };
    expect(() => {
      validateProfileSkills(profile);
    }).not.toThrow();
  });

  it("should not throw when neither is set", () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    expect(() => {
      validateProfileSkills(profile);
    }).not.toThrow();
  });

  it("should throw when loadSkills and noSkills are both set", () => {
    const profile: SubagentProfile = {
      loadSkills: ["my-skill"],
      noSkills: true,
    };
    expect(() => {
      validateProfileSkills(profile);
    }).toThrow(/mutually exclusive/);
  });
});

describe("resolveProfileSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return profile unchanged when no skills configured", async () => {
    const profile: SubagentProfile = { model: "anthropic/claude-sonnet-4" };
    const result = await resolveProfileSkills(profile, "/fake/cwd");
    expect(result).toEqual(profile);
  });

  it("should resolve suggestedSkills names to file paths", async () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        {
          name: "skill-a",
          filePath: "/skills/a/SKILL.md",
          description: "Skill A",
          baseDir: "/skills/a",
          sourceInfo: {
            path: "/skills/a/SKILL.md",
            source: "local",
            scope: "user",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
        {
          name: "skill-b",
          filePath: "/skills/b/SKILL.md",
          description: "Skill B",
          baseDir: "/skills/b",
          sourceInfo: {
            path: "/skills/b/SKILL.md",
            source: "local",
            scope: "user",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    });

    const profile: SubagentProfile = { suggestedSkills: ["skill-a", "skill-b"] };
    const result = await resolveProfileSkills(profile, "/fake/cwd");

    expect(result.suggestedSkills).toEqual(["/skills/a/SKILL.md", "/skills/b/SKILL.md"]);
  });

  it("should inject loadSkills content into appendSystemPrompt", async () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        {
          name: "coding",
          filePath: "/skills/coding/SKILL.md",
          description: "Coding skill",
          baseDir: "/skills/coding",
          sourceInfo: {
            path: "/skills/coding/SKILL.md",
            source: "local",
            scope: "user",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    });
    vi.mocked(readFileSync).mockReturnValue("---\nname: coding\n---\nYou are a coding expert.");
    vi.mocked(stripFrontmatter).mockReturnValue("You are a coding expert.");

    const profile: SubagentProfile = { loadSkills: ["coding"] };
    const result = await resolveProfileSkills(profile, "/fake/cwd");

    expect(result.appendSystemPrompt).toContain('<loaded_skill name="coding">');
    expect(result.appendSystemPrompt).toContain("You are a coding expert.");
    expect(result.appendSystemPrompt).toContain("</loaded_skill>");
  });

  it("should throw when suggestedSkill name not found", async () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [],
      diagnostics: [],
    });

    const profile: SubagentProfile = { suggestedSkills: ["unknown-skill"] };
    await expect(resolveProfileSkills(profile, "/fake/cwd")).rejects.toThrow(/Unknown skills/);
  });

  it("should throw when loadSkill name not found", async () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [],
      diagnostics: [],
    });

    const profile: SubagentProfile = { loadSkills: ["unknown-skill"] };
    await expect(resolveProfileSkills(profile, "/fake/cwd")).rejects.toThrow(/Unknown skills/);
  });

  it("should concatenate loadSkills content with existing appendSystemPrompt", async () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        {
          name: "testing",
          filePath: "/skills/testing/SKILL.md",
          description: "Testing skill",
          baseDir: "/skills/testing",
          sourceInfo: {
            path: "/skills/testing/SKILL.md",
            source: "local",
            scope: "user",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    });
    vi.mocked(readFileSync).mockReturnValue("---\nname: testing\n---\nRun all tests.");
    vi.mocked(stripFrontmatter).mockReturnValue("Run all tests.");

    const profile: SubagentProfile = {
      appendSystemPrompt: "Original prompt.",
      loadSkills: ["testing"],
    };
    const result = await resolveProfileSkills(profile, "/fake/cwd");

    expect(result.appendSystemPrompt).toContain("Original prompt.");
    expect(result.appendSystemPrompt).toContain('<loaded_skill name="testing">');
    expect(result.appendSystemPrompt).toContain("Run all tests.");
  });

  it("should skip loadSkills with empty body after stripping frontmatter", async () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        {
          name: "empty-skill",
          filePath: "/skills/empty/SKILL.md",
          description: "Empty skill",
          baseDir: "/skills/empty",
          sourceInfo: {
            path: "/skills/empty/SKILL.md",
            source: "local",
            scope: "user",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    });
    vi.mocked(readFileSync).mockReturnValue("---\nname: empty-skill\n---\n");
    vi.mocked(stripFrontmatter).mockReturnValue("");

    const profile: SubagentProfile = { loadSkills: ["empty-skill"] };
    const result = await resolveProfileSkills(profile, "/fake/cwd");

    expect(result.appendSystemPrompt).toBeUndefined();
    expect(result.loadSkills).toBeUndefined();
  });

  it("should set loadSkills to undefined after resolution", async () => {
    vi.mocked(discoverSkills).mockReturnValue({
      skills: [
        {
          name: "my-skill",
          filePath: "/skills/my/SKILL.md",
          description: "My skill",
          baseDir: "/skills/my",
          sourceInfo: {
            path: "/skills/my/SKILL.md",
            source: "local",
            scope: "user",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    });
    vi.mocked(readFileSync).mockReturnValue("---\nname: my-skill\n---\nDo stuff.");
    vi.mocked(stripFrontmatter).mockReturnValue("Do stuff.");

    const profile: SubagentProfile = { loadSkills: ["my-skill"] };
    const result = await resolveProfileSkills(profile, "/fake/cwd");

    expect(result.loadSkills).toBeUndefined();
  });
});

describe("loadProfilesFromDir (excludeTools parsing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should parse excludeTools from comma-separated string", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "string-exclude.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
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
    vi.mocked(readdirSync).mockReturnValue([
      { name: "array-exclude.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      ["---", "name: array-exclude", "excludeTools:", "  - bash", "  - write", "---", ""].join(
        "\n",
      ),
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
      .mockReturnValueOnce("---\nname: global-only\nprovider: openai\nmodel: gpt-4\n---\n")
      .mockReturnValueOnce("---\nname: shared\nprovider: anthropic\nmodel: claude-3\n---\n")
      .mockReturnValueOnce("---\nname: shared\nprovider: openai\nmodel: gpt-4o\n---\n")
      .mockReturnValueOnce("---\nname: project-only\nprovider: dashscope\nmodel: qwen-max\n---\n");

    // parseFrontmatter is called for each file
    vi.mocked(parseFrontmatter)
      .mockReturnValueOnce({
        frontmatter: { name: "global-only", provider: "openai", model: "gpt-4" },
        body: "",
      })
      .mockReturnValueOnce({
        frontmatter: { name: "shared", provider: "anthropic", model: "claude-3" },
        body: "",
      })
      .mockReturnValueOnce({
        frontmatter: { name: "shared", provider: "openai", model: "gpt-4o" },
        body: "",
      })
      .mockReturnValueOnce({
        frontmatter: { name: "project-only", provider: "dashscope", model: "qwen-max" },
        body: "",
      });

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
      ["---", "name: load-profile", "loadSkills:", "  - coding", "  - testing", "---", ""].join(
        "\n",
      ),
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
      [
        "---",
        "name: both-skills",
        "suggestedSkills: coding",
        "loadSkills:",
        "  - testing",
        "---",
        "",
      ].join("\n"),
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

// ── API Key Security Tests ──────────────────────────────────────────

describe("apiKey security in loadProfilesFromDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should load apiKey from global-scoped profiles", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "api-key-profile.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      ["---", "name: api-key-profile", "apiKey: sk-global-test-key", "---", ""].join("\n"),
    );
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: { name: "api-key-profile", apiKey: "sk-global-test-key" },
      body: "",
    });

    const profiles = await loadProfiles();
    expect(profiles["api-key-profile"]).toBeDefined();
    expect(profiles["api-key-profile"].apiKey).toBe("sk-global-test-key");
  });

  it("should refuse apiKey from project-scoped profiles and emit warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(existsSync).mockReturnValue(true);
    // First call = global dir (empty), second call = project dir (has the profile)
    vi.mocked(readdirSync)
      .mockReturnValueOnce([] as ReturnType<typeof readdirSync>)
      .mockReturnValueOnce([
        { name: "project-key.md", isFile: () => true },
      ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      ["---", "name: project-key", "apiKey: sk-project-secret", "---", ""].join("\n"),
    );
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: { name: "project-key", apiKey: "sk-project-secret" },
      body: "",
    });

    const profiles = await loadProfiles("/fake/project");
    expect(profiles["project-key"]).toBeDefined();
    // apiKey should NOT be loaded from project-scoped profile
    expect(profiles["project-key"].apiKey).toBeUndefined();

    // Warning should have been emitted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to load apiKey from project-local profile"),
    );

    warnSpy.mockRestore();
  });

  it("should load global profile apiKey but refuse project-local override with apiKey", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(existsSync).mockReturnValue(true);
    // Global dir has shared profile with apiKey, project dir overrides it
    vi.mocked(readdirSync)
      .mockReturnValueOnce([{ name: "shared.md", isFile: () => true }] as unknown as ReturnType<
        typeof readdirSync
      >)
      .mockReturnValueOnce([{ name: "shared.md", isFile: () => true }] as unknown as ReturnType<
        typeof readdirSync
      >);
    vi.mocked(readFileSync)
      .mockReturnValueOnce(
        ["---", "name: shared", "apiKey: sk-global-key", "model: gpt-4", "---", ""].join("\n"),
      )
      .mockReturnValueOnce(
        ["---", "name: shared", "apiKey: sk-project-key", "model: gpt-4o", "---", ""].join("\n"),
      );
    vi.mocked(parseFrontmatter)
      .mockReturnValueOnce({
        frontmatter: { name: "shared", apiKey: "sk-global-key", model: "gpt-4" },
        body: "",
      })
      .mockReturnValueOnce({
        frontmatter: { name: "shared", apiKey: "sk-project-key", model: "gpt-4o" },
        body: "",
      });

    const profiles = await loadProfiles("/fake/project");

    // Project-local override should have the new model but NOT the apiKey
    expect(profiles["shared"]).toBeDefined();
    expect(profiles["shared"].model).toBe("gpt-4o");
    expect(profiles["shared"].apiKey).toBeUndefined();

    // Warning should have been emitted for the project-scoped apiKey
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to load apiKey from project-local profile"),
    );

    warnSpy.mockRestore();
  });
});

// ── Skill Path Validation Tests ─────────────────────────────────────

describe("profileToArgs skill path validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw when suggestedSkill path is outside safe directories", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["/etc/passwd"],
    };
    expect(() => profileToArgs(profile, "/safe/cwd", "/safe/agent")).toThrow(
      /outside allowed directories/,
    );
  });

  it("should allow skill paths within cwd", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["/safe/cwd/.pi/skills/my-skill/SKILL.md"],
    };
    const result = profileToArgs(profile, "/safe/cwd");
    expect(result.args).toContain("--skill");
    expect(result.args).toContain("/safe/cwd/.pi/skills/my-skill/SKILL.md");
  });

  it("should allow skill paths within agentDir", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["/safe/agent/skills/my-skill/SKILL.md"],
    };
    const result = profileToArgs(profile, "/some/cwd", "/safe/agent");
    expect(result.args).toContain("--skill");
    expect(result.args).toContain("/safe/agent/skills/my-skill/SKILL.md");
  });

  it("should skip validation when no cwd or agentDir provided", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["/any/path/SKILL.md"],
    };
    const result = profileToArgs(profile);
    expect(result.args).toContain("--skill");
    expect(result.args).toContain("/any/path/SKILL.md");
  });

  it("should throw when skill path uses traversal to escape cwd", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["/safe/cwd/../../../etc/shadow"],
    };
    expect(() => profileToArgs(profile, "/safe/cwd")).toThrow(/outside allowed directories/);
  });

  it("should allow multiple skill paths all within cwd", () => {
    const profile: SubagentProfile = {
      suggestedSkills: ["/project/.pi/skills/a/SKILL.md", "/project/.pi/skills/b/SKILL.md"],
    };
    const result = profileToArgs(profile, "/project");
    const skillArgs = result.args.filter((_, i) => result.args[i - 1] === "--skill");
    expect(skillArgs).toHaveLength(2);
    expect(skillArgs).toContain("/project/.pi/skills/a/SKILL.md");
    expect(skillArgs).toContain("/project/.pi/skills/b/SKILL.md");
  });
});

// ── Profile Round-Trip Tests ──────────────────────────────────────────

describe("profile round-trip: serializeProfileToMarkdown → parse → verify fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should survive round-trip for a profile with all field types", async () => {
    const original: SubagentProfile = {
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4",
      thinkingLevel: "high",
      systemPrompt: "You are an expert coder.",
      appendSystemPrompt: "Be thorough.",
      noTools: false,
      tools: ["read", "bash", "grep"],
      noExtensions: false,
      extensions: ["/ext/custom.js"],
      noSkills: false,
      noContextFiles: true,
      extraArgs: ["--verbose"],
      suggestedSkills: ["coding", "testing"],
    };

    const md = serializeProfileToMarkdown("round-trip-profile", original);

    // Parse the markdown through loadProfiles
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "round-trip-profile.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(md);
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: {
        name: "round-trip-profile",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4",
        thinkingLevel: "high",
        appendSystemPrompt: "Be thorough.",
        noTools: false,
        tools: "read,bash,grep",
        noExtensions: false,
        extensions: "/ext/custom.js",
        noSkills: false,
        noContextFiles: true,
        extraArgs: "--verbose",
        suggestedSkills: "coding,testing",
      },
      body: "You are an expert coder.",
    });

    const profiles = await loadProfiles();
    const parsed = profiles["round-trip-profile"];

    expect(parsed).toBeDefined();
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4");
    expect(parsed.thinkingLevel).toBe("high");
    expect(parsed.systemPrompt).toBe("You are an expert coder.");
    expect(parsed.appendSystemPrompt).toBe("Be thorough.");
    expect(parsed.tools).toEqual(["read", "bash", "grep"]);
    expect(parsed.extensions).toEqual(["/ext/custom.js"]);
    expect(parsed.noContextFiles).toBe(true);
    expect(parsed.extraArgs).toEqual(["--verbose"]);
    expect(parsed.suggestedSkills).toEqual(["coding", "testing"]);
    // noTools=false should not be set (falsy booleans are omitted)
    expect(parsed.noTools).toBeUndefined();
    // noExtensions=false should not be set
    expect(parsed.noExtensions).toBeUndefined();
    // noSkills=false should not be set
    expect(parsed.noSkills).toBeUndefined();
  });

  it("should survive round-trip for a minimal profile with only model", async () => {
    const original: SubagentProfile = {
      model: "openai/gpt-4o",
    };

    const md = serializeProfileToMarkdown("minimal", original);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "minimal.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(md);
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: { name: "minimal", model: "openai/gpt-4o" },
      body: "",
    });

    const profiles = await loadProfiles();
    const parsed = profiles["minimal"];

    expect(parsed).toBeDefined();
    expect(parsed.model).toBe("openai/gpt-4o");
    expect(parsed.systemPrompt).toBeUndefined();
    expect(parsed.tools).toBeUndefined();
  });

  it("should survive round-trip for a profile with excludeTools", async () => {
    const original: SubagentProfile = {
      model: "anthropic/claude-sonnet-4",
      excludeTools: ["write", "bash"],
    };

    const md = serializeProfileToMarkdown("excl-profile", original);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "excl-profile.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(md);
    vi.mocked(parseFrontmatter).mockReturnValue({
      frontmatter: {
        name: "excl-profile",
        model: "anthropic/claude-sonnet-4",
        excludeTools: "write,bash",
      },
      body: "",
    });

    const profiles = await loadProfiles();
    const parsed = profiles["excl-profile"];

    expect(parsed).toBeDefined();
    expect(parsed.model).toBe("anthropic/claude-sonnet-4");
    expect(parsed.excludeTools).toEqual(["write", "bash"]);
  });
});

// ── loadProfiles Cache Expiration Tests ───────────────────────────────

describe("loadProfiles cache expiration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should re-read profiles after TTL expires", async () => {
    vi.useFakeTimers();

    try {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([]);

      // First call populates the cache
      await loadProfiles();
      const firstCallCount = vi.mocked(readdirSync).mock.calls.length;
      expect(firstCallCount).toBeGreaterThanOrEqual(1);

      // Second call within TTL should hit the cache
      await loadProfiles();
      expect(vi.mocked(readdirSync).mock.calls.length).toBe(firstCallCount);

      // Advance past the TTL (5000ms)
      vi.advanceTimersByTime(5001);

      // Third call after TTL should re-read from disk
      await loadProfiles();
      expect(vi.mocked(readdirSync).mock.calls.length).toBeGreaterThan(firstCallCount);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── loadProfiles Unreadable File Tests ────────────────────────────────

describe("loadProfiles with unreadable file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfilesCache();
  });

  it("should gracefully degrade when a profile file cannot be read", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: "good.md", isFile: () => true },
      { name: "bad.md", isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);

    vi.mocked(readFileSync)
      .mockReturnValueOnce("---\nname: good\nmodel: openai/gpt-4o\n---\n")
      .mockImplementationOnce(() => {
        throw new Error("EACCES: permission denied");
      });

    vi.mocked(parseFrontmatter).mockReturnValueOnce({
      frontmatter: { name: "good", model: "openai/gpt-4o" },
      body: "",
    });

    const profiles = await loadProfiles();

    // Good profile should still be loaded
    expect(profiles["good"]).toBeDefined();
    expect(profiles["good"].model).toBe("openai/gpt-4o");

    // Bad profile should not be present (graceful degradation)
    expect(profiles["bad"]).toBeUndefined();

    // A warning should have been emitted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load profile"),
      expect.any(String),
    );

    warnSpy.mockRestore();
  });
});
