/**
 * Tests for src/commands/profile.ts — /profile slash command handler.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("../profiles", () => ({
  loadProfiles: vi.fn(),
  formatProfileDetail: vi.fn(),
  profileSummary: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("../profile-editor", () => ({
  editProfileInteractive: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  // registerProfileCommand uses ExtensionAPI only for registerCommand
}));

import { editProfileInteractive } from "../profile-editor";
import { deleteProfile, formatProfileDetail, loadProfiles, profileSummary } from "../profiles";
import { registerProfileCommand } from "../commands/profile";

// ── Helpers ──────────────────────────────────────────────────────────

/** Captured command object from registerCommand. */
let command: {
  description: string;
  getArgumentCompletions(prefix: string): Promise<{ value: string; label: string }[] | null>;
  handler(args: string, ctx: any): Promise<void>;
};

/** Build a minimal ExtensionAPI that captures the registered command. */
function createPi(): any {
  return {
    registerCommand(_name: string, cmd: any) {
      command = cmd;
    },
  };
}

/** Build a mock context with stubbed ui. */
function createCtx(confirmResult = true) {
  return {
    cwd: "/tmp/project",
    ui: {
      notify: vi.fn(),
      confirm: vi.fn().mockResolvedValue(confirmResult),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registerProfileCommand(createPi());
});

// ── Tests ────────────────────────────────────────────────────────────

describe("/profile command", () => {
  // ── 1. /profile list — empty ─────────────────────────────────────
  it("list: shows info message when no profiles exist", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({});
    const ctx = createCtx();

    await command.handler("list", ctx);

    expect(loadProfiles).toHaveBeenCalledWith("/tmp/project");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No subagent profiles found"),
      "info",
    );
  });

  // ── 2. /profile list — populated ─────────────────────────────────
  it("list: lists all profiles with summaries", async () => {
    const profiles = {
      "my-profile": { provider: "anthropic" },
      "other-profile": { provider: "openai" },
    };
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue(profiles);
    (profileSummary as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string) => `summary:${name}`,
    );
    const ctx = createCtx();

    await command.handler("list", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Subagent profiles:"),
      "info",
    );
    // Both profiles should be summarized
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("summary:my-profile"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("summary:other-profile"),
      "info",
    );
  });

  // ── 3. /profile ls (alias) ───────────────────────────────────────
  it("ls: works as alias for list", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({});
    const ctx = createCtx();

    await command.handler("ls", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No subagent profiles found"),
      "info",
    );
  });

  // ── 4. /profile show <name> — existing ───────────────────────────
  it("show: displays profile detail for existing profile", async () => {
    const profiles = { "my-profile": { provider: "anthropic" } };
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue(profiles);
    (formatProfileDetail as ReturnType<typeof vi.fn>).mockReturnValue("detail:my-profile");
    const ctx = createCtx();

    await command.handler("show my-profile", ctx);

    expect(formatProfileDetail).toHaveBeenCalledWith("my-profile", profiles["my-profile"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("detail:my-profile", "info");
  });

  // ── 5. /profile show <name> — non-existing ───────────────────────
  it("show: shows error when profile not found", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({});
    const ctx = createCtx();

    await command.handler("show missing", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Profile "missing" not found'),
      "error",
    );
  });

  // ── 6. /profile show (no name) — usage ───────────────────────────
  it("show: shows usage when no name is given", async () => {
    const ctx = createCtx();

    await command.handler("show", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /profile show <name>", "warning");
  });

  // ── 7. /profile create <name> — valid ────────────────────────────
  it("create: opens editor for valid new name", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({});
    const ctx = createCtx();

    await command.handler("create my-agent", ctx);

    expect(editProfileInteractive).toHaveBeenCalledWith("my-agent", {}, ctx);
  });

  // ── 8. /profile create <name> — invalid name ─────────────────────
  it("create: rejects name with special characters", async () => {
    const ctx = createCtx();

    // "@bad" fails the /^[a-zA-Z0-9_-]+$/ regex
    await command.handler("create @bad", ctx);

    expect(editProfileInteractive).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("alphanumeric, hyphens, underscores"),
      "warning",
    );
  });

  // ── 9. /profile create <existing> — duplicate ────────────────────
  it("create: warns when profile already exists", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({
      "my-profile": { provider: "anthropic" },
    });
    const ctx = createCtx();

    await command.handler("create my-profile", ctx);

    expect(editProfileInteractive).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "warning",
    );
  });

  // ── 10. /profile edit <name> — existing ──────────────────────────
  it("edit: opens editor with existing profile data", async () => {
    const existing = { provider: "anthropic", model: "claude-sonnet" };
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({
      "my-profile": existing,
    });
    const ctx = createCtx();

    await command.handler("edit my-profile", ctx);

    expect(editProfileInteractive).toHaveBeenCalledWith(
      "my-profile",
      { provider: "anthropic", model: "claude-sonnet" },
      ctx,
    );
  });

  // ── 11. /profile edit <name> — non-existing ──────────────────────
  it("edit: shows error when profile not found", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({});
    const ctx = createCtx();

    await command.handler("edit ghost", ctx);

    expect(editProfileInteractive).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Profile "ghost" not found'),
      "error",
    );
  });

  // ── 12. /profile delete <name> — confirm yes ─────────────────────
  it("delete: deletes profile when confirmed (global)", async () => {
    (deleteProfile as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const ctx = createCtx(true);

    await command.handler("delete my-profile", ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Delete profile?",
      expect.stringContaining("my-profile"),
    );
    expect(deleteProfile).toHaveBeenCalledWith("my-profile", "global");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("deleted"), "info");
  });

  // ── 13. /profile delete <name> — confirm no ──────────────────────
  it("delete: aborts when user declines confirmation", async () => {
    const ctx = createCtx(false);

    await command.handler("delete my-profile", ctx);

    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  // ── 14. /profile rm (alias) ──────────────────────────────────────
  it("rm: works as alias for delete", async () => {
    (deleteProfile as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const ctx = createCtx(true);

    await command.handler("rm my-profile", ctx);

    expect(deleteProfile).toHaveBeenCalledWith("my-profile", "global");
  });

  // ── 15. /profile <bare-name> — alias for show ────────────────────
  it("bare name: shows profile detail when profile exists", async () => {
    const profiles = { "my-profile": { provider: "anthropic" } };
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue(profiles);
    (formatProfileDetail as ReturnType<typeof vi.fn>).mockReturnValue("detail:my-profile");
    const ctx = createCtx();

    await command.handler("my-profile", ctx);

    expect(formatProfileDetail).toHaveBeenCalledWith("my-profile", profiles["my-profile"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("detail:my-profile", "info");
  });

  // ── 16. Fallback usage message ───────────────────────────────────
  it("fallback: shows usage for unknown subcommand with no matching profile", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({});
    const ctx = createCtx();

    await command.handler("unknown-thing", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /profile"),
      "warning",
    );
  });

  // ── 17. getArgumentCompletions ───────────────────────────────────
  it("getArgumentCompletions: returns matching profiles and subcommands", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({
      "dev-agent": { provider: "anthropic" },
      "prod-agent": { provider: "openai" },
    });

    const result = await command.getArgumentCompletions("de");

    expect(result).not.toBeNull();
    const values = result!.map((r: { value: string }) => r.value);
    expect(values).toContain("delete");
    expect(values).toContain("dev-agent");
  });

  it("getArgumentCompletions: returns null when nothing matches", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({
      "dev-agent": { provider: "anthropic" },
    });

    const result = await command.getArgumentCompletions("zzz");

    expect(result).toBeNull();
  });

  // ── 18. handleList: profile value is falsy ──────────────────────
  it("list: filters out profiles with falsy values", async () => {
    const profiles = {
      "valid-profile": { provider: "anthropic" },
      "null-profile": null as any,
    };
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue(profiles);
    (profileSummary as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string) => `summary:${name}`,
    );
    const ctx = createCtx();

    await command.handler("list", ctx);

    // Should only include valid-profile, not null-profile
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("summary:valid-profile"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("summary:null-profile"),
      "info",
    );
  });

  // ── 19. handleShow: profile value is falsy after hasOwn ─────────
  it("show: does nothing when profile value is falsy", async () => {
    const profiles = { ghost: null as any };
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue(profiles);
    const ctx = createCtx();

    await command.handler("show ghost", ctx);

    // formatProfileDetail should NOT be called since profile is falsy
    expect(formatProfileDetail).not.toHaveBeenCalled();
    // No notification should be sent (silent no-op)
    const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const infoCalls = calls.filter((c: any) => c[1] === "info");
    expect(infoCalls).toHaveLength(0);
  });

  // ── 20. handleEdit: no name provided ───────────────────────────
  it("edit: shows usage when no name is given", async () => {
    const ctx = createCtx();

    await command.handler("edit", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /profile edit <name>", "warning");
  });

  // ── 21. handleDelete: no name provided ─────────────────────────
  it("delete: shows usage when no name is given", async () => {
    const ctx = createCtx(true);

    await command.handler("delete", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /profile delete <name>", "warning");
  });

  // ── 22. handleDelete: neither global nor project profile deleted ─
  it("delete: shows error when profile not found in either scope", async () => {
    (deleteProfile as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const ctx = createCtx(true);

    await command.handler("delete nonexistent", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Profile "nonexistent" not found'),
      "error",
    );
  });

  // ── 23. handleBareName: profile value is falsy ──────────────────
  it("bare name: does not notify when profile value is falsy", async () => {
    const profiles = { ghost: null as any };
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue(profiles);
    const ctx = createCtx();

    await command.handler("ghost", ctx);

    // handleBareName returns true (hasOwn matches) but doesn't notify
    expect(formatProfileDetail).not.toHaveBeenCalled();
    // No notification at all — it's a silent return true
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  // ── 24. handler: empty args ────────────────────────────────────
  it("handler: shows usage when args is empty string", async () => {
    (loadProfiles as ReturnType<typeof vi.fn>).mockReturnValue({});
    const ctx = createCtx();

    await command.handler("", ctx);

    // Empty args → tokens = [""], sub = "" → doesn't match any subcommand,
    // doesn't match SUBCOMMAND_RE, doesn't match handleBareName → usage
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /profile"),
      "warning",
    );
  });
});
