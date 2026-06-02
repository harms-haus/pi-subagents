/**
 * Tests for src/profile-editor.ts — editProfileInteractive wizard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("../profiles", () => ({
  saveProfile: vi.fn(),
  formatProfileDetail: vi.fn(),
}));

import { editProfileInteractive } from "../profile-editor";
import { formatProfileDetail, saveProfile } from "../profiles";

// ── Helpers ──────────────────────────────────────────────────────────

interface MockUI {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  editor: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}

function createCtx(ui: MockUI) {
  return { ui, cwd: "/tmp/project" } as unknown as Parameters<typeof editProfileInteractive>[2];
}

/**
 * Helper to build a mock UI from a sequence of interaction steps.
 * Each call to a UI method consumes the next value in its queue.
 */
function queueUISteps(steps: {
  selects?: (string | undefined)[];
  inputs?: (string | undefined)[];
  confirms?: boolean[];
  editors?: (string | undefined)[];
}): MockUI {
  const selectQueue = [...(steps.selects ?? [])];
  const inputQueue = [...(steps.inputs ?? [])];
  const confirmQueue = [...(steps.confirms ?? [])];
  const editorQueue = [...(steps.editors ?? [])];

  return {
    select: vi.fn().mockImplementation(() => {
      return Promise.resolve(selectQueue.shift());
    }),
    input: vi.fn().mockImplementation(() => {
      return Promise.resolve(inputQueue.shift());
    }),
    confirm: vi.fn().mockImplementation(() => {
      return Promise.resolve(confirmQueue.shift());
    }),
    editor: vi.fn().mockImplementation(() => {
      return Promise.resolve(editorQueue.shift());
    }),
    notify: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (formatProfileDetail as ReturnType<typeof vi.fn>).mockReturnValue("profile-detail-mock");
});

// ── Tests ────────────────────────────────────────────────────────────

describe("editProfileInteractive", () => {
  // ── 1. User cancels at scope selection ────────────────────────────
  it("returns early when user cancels at scope selection", async () => {
    const ui = queueUISteps({
      selects: [undefined],
    });
    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
    // Should not have progressed past scope
    expect(ui.input).not.toHaveBeenCalled();
  });

  // ── 2. User cancels at provider input ─────────────────────────────
  it("returns early when user cancels at provider input", async () => {
    const ui = queueUISteps({
      selects: ["Global (~/.pi/agent/agent-profiles/test.md)"],
      inputs: [undefined], // cancel at provider
    });
    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
    // Should have asked for provider but not model
    expect(ui.input).toHaveBeenCalledTimes(1);
  });

  // ── 3. User completes full wizard with all fields set ─────────────
  it("completes full wizard and saves with all fields set", async () => {
    const ui = queueUISteps({
      selects: [
        "Project (.pi/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude-sonnet", // model
        "Be helpful", // appendSystemPrompt
      ],
      confirms: [
        true, // system prompt?
        false, // append system prompt? — actually we'll test no
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
      editors: [
        "You are a helpful assistant.", // system prompt content
      ],
    });

    await editProfileInteractive("my-agent", {}, createCtx(ui));

    // Verify save was called with correct data and scope
    expect(saveProfile).toHaveBeenCalledWith(
      "my-agent",
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet",
        systemPrompt: "You are a helpful assistant.",
      }),
      "project",
      "/tmp/project",
    );
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("my-agent"), "info");
  });

  // ── 4. User sets thinking level ───────────────────────────────────
  it("sets thinking level when user confirms and selects one", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        "high", // thinking level
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        true, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("thinker", {}, createCtx(ui));

    expect(saveProfile).toHaveBeenCalledWith(
      "thinker",
      expect.objectContaining({
        thinkingLevel: "high",
      }),
      "global",
      "/tmp/project",
    );
  });

  // ── 5. User disables all tools (noTools) ──────────────────────────
  it("sets noTools when user disables all tools", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        true, // disable all tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("notools-agent", {}, createCtx(ui));

    expect(saveProfile).toHaveBeenCalledWith(
      "notools-agent",
      expect.objectContaining({
        noTools: true,
      }),
      "global",
      "/tmp/project",
    );

    // Verify no tools or excludeTools set
    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.tools).toBeUndefined();
    expect(savedProfile.excludeTools).toBeUndefined();
  });

  // ── 6. User configures tool allowlist ─────────────────────────────
  it("configures tool allowlist when user selects allowlist mode", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        "Allowlist (only these tools)", // tool mode
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "read, bash, grep", // tools allowlist
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        false, // disable all tools? — no
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("allow-agent", {}, createCtx(ui));

    expect(saveProfile).toHaveBeenCalledWith(
      "allow-agent",
      expect.objectContaining({
        tools: ["read", "bash", "grep"],
      }),
      "global",
      "/tmp/project",
    );

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.noTools).toBeUndefined();
    expect(savedProfile.excludeTools).toBeUndefined();
  });

  // ── 7. User configures tool blacklist ─────────────────────────────
  it("configures tool blacklist when user selects blacklist mode", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        "Blacklist (all tools except these)", // tool mode
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "bash, write", // excluded tools
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        false, // disable all tools? — no
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("blacklist-agent", {}, createCtx(ui));

    expect(saveProfile).toHaveBeenCalledWith(
      "blacklist-agent",
      expect.objectContaining({
        excludeTools: ["bash", "write"],
      }),
      "global",
      "/tmp/project",
    );

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.noTools).toBeUndefined();
    expect(savedProfile.tools).toBeUndefined();
  });

  // ── 8. User disables all extensions ───────────────────────────────
  it("sets noExtensions when user disables all extensions", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        true, // configure extensions?
        true, // disable all extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("noext-agent", {}, createCtx(ui));

    expect(saveProfile).toHaveBeenCalledWith(
      "noext-agent",
      expect.objectContaining({
        noExtensions: true,
      }),
      "global",
      "/tmp/project",
    );

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.extensions).toBeUndefined();
  });

  // ── 9. User cancels at final save confirmation ────────────────────
  it("does not save when user cancels at final save confirmation", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        false, // save confirmation — CANCEL
      ],
    });

    await editProfileInteractive("cancelled", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Cancelled.", "info");
  });

  // ── 10. Successful save calls saveProfile with correct data ───────
  it("calls formatProfileDetail before save and passes correct data", async () => {
    const ui2 = queueUISteps({
      selects: [
        "Project (.pi/agent-profiles/test.md)", // scope
        "medium", // thinking level
      ],
      inputs: [
        "openai", // provider
        "gpt-4", // model
        "Focus on testing.", // appendSystemPrompt
      ],
      confirms: [
        true, // system prompt?
        true, // append system prompt?
        true, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
      editors: [
        "You are a testing expert.", // system prompt content
      ],
    });

    await editProfileInteractive("full-agent", {}, createCtx(ui2));

    // Verify formatProfileDetail was called to build the summary
    expect(formatProfileDetail).toHaveBeenCalledWith("full-agent", expect.any(Object));

    // Verify saveProfile was called with all the right data
    expect(saveProfile).toHaveBeenCalledWith(
      "full-agent",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4",
        systemPrompt: "You are a testing expert.",
        appendSystemPrompt: "Focus on testing.",
        thinkingLevel: "medium",
      }),
      "project",
      "/tmp/project",
    );

    // Verify success notification
    expect(ui2.notify).toHaveBeenCalledWith(expect.stringContaining("full-agent"), "info");
  });

  // ── Extra: cancelling at model input ──────────────────────────────
  it("returns early when user cancels at model input", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        undefined, // cancel at model
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: clearing provider by entering empty string ─────────────
  it("removes provider from profile when user enters empty string", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "", // empty provider → delete provider
        "gpt-4", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", { provider: "anthropic" }, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.provider).toBeUndefined();
    expect(savedProfile.model).toBe("gpt-4");
  });

  // ── Extra: cancelling at system prompt editor ─────────────────────
  it("returns early when user cancels at system prompt editor", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        true, // system prompt?
      ],
      editors: [
        undefined, // cancel at editor
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: declining system prompt removes it ─────────────────────
  it("removes systemPrompt when user declines system prompt", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt? — no
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", { systemPrompt: "old prompt" }, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.systemPrompt).toBeUndefined();
  });

  // ── Extra: cancelling at append system prompt input ───────────────
  it("returns early when user cancels at append system prompt input", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        undefined, // cancel at append
      ],
      confirms: [
        false, // system prompt?
        true, // append system prompt?
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: declining append prompt removes it ─────────────────────
  it("removes appendSystemPrompt when user declines append", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt? — no
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", { appendSystemPrompt: "old append" }, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.appendSystemPrompt).toBeUndefined();
  });

  // ── Extra: declining thinking level removes it ────────────────────
  it("removes thinkingLevel when user declines thinking", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level? — no
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", { thinkingLevel: "high" as const }, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.thinkingLevel).toBeUndefined();
  });

  // ── Extra: cancelling at tool mode select ─────────────────────────
  it("returns early when user cancels at tool mode select", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        undefined, // cancel at tool mode select
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        false, // disable all tools? — no
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: cancelling at tool allowlist input ─────────────────────
  it("returns early when user cancels at allowlist input", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        "Allowlist (only these tools)", // tool mode
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        undefined, // cancel at tools input
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        false, // disable all tools? — no
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: cancelling at blacklist input ──────────────────────────
  it("returns early when user cancels at blacklist input", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        "Blacklist (all tools except these)", // tool mode
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        undefined, // cancel at exclude input
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        false, // disable all tools? — no
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: empty allowlist clears tools ───────────────────────────
  it("clears tools when user enters empty allowlist string", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        "Allowlist (only these tools)", // tool mode
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "", // empty tools string → delete tools
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        false, // disable all tools? — no
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", { tools: ["read", "bash"] }, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.tools).toBeUndefined();
  });

  // ── Extra: empty blacklist clears excludeTools ────────────────────
  it("clears excludeTools when user enters empty blacklist string", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        "Blacklist (all tools except these)", // tool mode
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "", // empty exclude string → delete excludeTools
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        false, // disable all tools? — no
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", { excludeTools: ["bash"] }, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.excludeTools).toBeUndefined();
  });

  // ── Extra: configuring extension paths ────────────────────────────
  it("configures extension paths when user enters comma-separated list", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "/path/to/ext1, /path/to/ext2", // extensions
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        true, // configure extensions?
        false, // disable all extensions? — no
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("ext-agent", {}, createCtx(ui));

    expect(saveProfile).toHaveBeenCalledWith(
      "ext-agent",
      expect.objectContaining({
        extensions: ["/path/to/ext1", "/path/to/ext2"],
      }),
      "global",
      "/tmp/project",
    );
  });

  // ── Extra: cancelling at extensions input ─────────────────────────
  it("returns early when user cancels at extensions input", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        undefined, // cancel at extensions input
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        true, // configure extensions?
        false, // disable all extensions? — no
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: empty extension string clears extensions ───────────────
  it("clears extensions when user enters empty extension string", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "", // empty extensions → delete
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        true, // configure extensions?
        false, // disable all extensions? — no
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", { extensions: ["/old/ext"] }, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.extensions).toBeUndefined();
  });

  // ── Extra: initial profile values are preserved when skipped ──────
  it("preserves initial profile values for fields the user skips", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "", // provider — empty, clears it
        "", // model — empty, clears it
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    // When provider and model are empty strings, they get deleted
    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.provider).toBeUndefined();
    expect(savedProfile.model).toBeUndefined();
  });

  // ── Extra: tool list is trimmed and empty entries filtered ────────
  it("trims and filters empty entries in tool allowlist", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
        "Allowlist (only these tools)", // tool mode
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "read, bash, , grep,", // tools with empty entries
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        true, // configure tools?
        false, // disable all tools? — no
        false, // configure extensions?
        false, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.tools).toEqual(["read", "bash", "grep"]);
  });

  // ── Extra: configuring skills ───────────────────────────────────────
  it("configures both suggestedSkills and loadSkills when user enters comma-separated lists", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "skill1, skill2, skill3", // suggestedSkills
        "skill4, skill5", // loadSkills
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        true, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({
        suggestedSkills: ["skill1", "skill2", "skill3"],
        loadSkills: ["skill4", "skill5"],
      }),
      "global",
      "/tmp/project",
    );
  });

  // ── Extra: cancelling at suggestedSkills input ──────────────────────
  it("returns early when user cancels at suggestedSkills input", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        undefined, // cancel at suggestedSkills input
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        true, // configure skills?
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: cancelling at loadSkills input ──────────────────────────
  it("returns early when user cancels at loadSkills input", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "skill1, skill2", // suggestedSkills
        undefined, // cancel at loadSkills input
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        true, // configure skills?
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    expect(saveProfile).not.toHaveBeenCalled();
  });

  // ── Extra: empty suggestedSkills leaves it unset ────────────────────
  it("leaves suggestedSkills unset when user enters empty string", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "", // empty suggestedSkills → not set
        "skill1", // loadSkills
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        true, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.suggestedSkills).toBeUndefined();
    expect(savedProfile.loadSkills).toEqual(["skill1"]);
  });

  // ── Extra: empty loadSkills leaves it unset ──────────────────────────
  it("leaves loadSkills unset when user enters empty string", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "skill1", // suggestedSkills
        "", // empty loadSkills → not set
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        true, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.loadSkills).toBeUndefined();
    expect(savedProfile.suggestedSkills).toEqual(["skill1"]);
  });

  // ── Extra: declining skills removal preserves existing skills ──────
  it("preserves existing skills when user declines removal", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        false, // remove skills? — no → keep
        true, // save confirmation
      ],
    });

    await editProfileInteractive(
      "test",
      { suggestedSkills: ["oldSkill1"], loadSkills: ["oldSkill2"] },
      createCtx(ui),
    );

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.suggestedSkills).toEqual(["oldSkill1"]);
    expect(savedProfile.loadSkills).toEqual(["oldSkill2"]);
  });

  // ── Extra: confirming skills removal deletes both properties ──────────
  it("removes both suggestedSkills and loadSkills when user confirms removal", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        true, // remove skills? — yes → delete
        true, // save confirmation
      ],
    });

    await editProfileInteractive(
      "test",
      { suggestedSkills: ["oldSkill1"], loadSkills: ["oldSkill2"] },
      createCtx(ui),
    );

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.suggestedSkills).toBeUndefined();
    expect(savedProfile.loadSkills).toBeUndefined();
  });

  // ── Extra: skills list is trimmed and empty entries filtered ────────
  it("trims and filters empty entries in skills lists", async () => {
    const ui = queueUISteps({
      selects: [
        "Global (~/.pi/agent/agent-profiles/test.md)", // scope
      ],
      inputs: [
        "anthropic", // provider
        "claude", // model
        "skill1, skill2, , skill3,", // suggestedSkills with empty entries
        "skill4, , skill5", // loadSkills with empty entries
      ],
      confirms: [
        false, // system prompt?
        false, // append system prompt?
        false, // thinking level?
        false, // configure tools?
        false, // configure extensions?
        true, // configure skills?
        true, // save confirmation
      ],
    });

    await editProfileInteractive("test", {}, createCtx(ui));

    const savedProfile = (saveProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedProfile.suggestedSkills).toEqual(["skill1", "skill2", "skill3"]);
    expect(savedProfile.loadSkills).toEqual(["skill4", "skill5"]);
  });
});
