/**
 * /profile Slash Command
 *
 * Command registration for managing subagent profiles.
 */

import { editProfileInteractive } from "../profile-editor";
import { deleteProfile, formatProfileDetail, loadProfiles, profileSummary } from "../profiles";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Subset of ExtensionCommandContext used by the profile command */
type ProfileCommandContext = Pick<ExtensionCommandContext, "cwd" | "ui">;

/** Handle /profile list subcommand. */
function handleList(ctx: ProfileCommandContext): void {
  const profiles = loadProfiles(ctx.cwd);
  const names = Object.keys(profiles);
  if (names.length === 0) {
    ctx.ui.notify(
      "No subagent profiles found. Add .md files to ~/.pi/agent/profiles/ or use /profile create.",
      "info",
    );
    return;
  }
  const lines = names
    .map((n) => {
      const p = profiles[n];
      return p ? `  ${profileSummary(n, p)}` : null;
    })
    .filter((l): l is string => l !== null);
  ctx.ui.notify(`Subagent profiles:\n${lines.join("\n")}`, "info");
}

/** Handle /profile show <name> subcommand. */
function handleShow(tokens: string[], ctx: ProfileCommandContext): void {
  const name = tokens[1];
  if (!name) {
    ctx.ui.notify("Usage: /profile show <name>", "warning");
    return;
  }
  const profiles = loadProfiles(ctx.cwd);
  if (!Object.hasOwn(profiles, name)) {
    ctx.ui.notify(
      `Profile "${name}" not found. Available: ${Object.keys(profiles).join(", ") || "(none)"}`,
      "error",
    );
    return;
  }
  const profile = profiles[name];
  if (profile) {
    ctx.ui.notify(formatProfileDetail(name, profile), "info");
  }
}

/** Handle /profile create <name> subcommand. */
async function handleCreate(tokens: string[], ctx: ProfileCommandContext): Promise<void> {
  const name = tokens[1];
  if (!(name && /^[a-zA-Z0-9_-]+$/.test(name))) {
    ctx.ui.notify("Usage: /profile create <name>  (alphanumeric, hyphens, underscores)", "warning");
    return;
  }
  const profiles = loadProfiles(ctx.cwd);
  if (Object.hasOwn(profiles, name)) {
    ctx.ui.notify(
      `Profile "${name}" already exists. Use /profile edit ${name} to modify it.`,
      "warning",
    );
    return;
  }
  await editProfileInteractive(name, {}, ctx);
}

/** Handle /profile edit <name> subcommand. */
async function handleEdit(tokens: string[], ctx: ProfileCommandContext): Promise<void> {
  const name = tokens[1];
  if (!name) {
    ctx.ui.notify("Usage: /profile edit <name>", "warning");
    return;
  }
  const profiles = loadProfiles(ctx.cwd);
  if (!Object.hasOwn(profiles, name)) {
    ctx.ui.notify(
      `Profile "${name}" not found. Use /profile create ${name} to create it.`,
      "error",
    );
    return;
  }
  await editProfileInteractive(name, { ...profiles[name] }, ctx);
}

/** Handle /profile delete <name> subcommand. */
async function handleDelete(tokens: string[], ctx: ProfileCommandContext): Promise<void> {
  const name = tokens[1];
  if (!name) {
    ctx.ui.notify("Usage: /profile delete <name>", "warning");
    return;
  }
  const ok = await ctx.ui.confirm("Delete profile?", `Delete subagent profile "${name}"?`);
  if (!ok) {
    return;
  }
  const deleted = await deleteProfile(name, "global");
  const deletedProject = await deleteProfile(name, "project", ctx.cwd);
  if (deleted || deletedProject) {
    ctx.ui.notify(`Profile "${name}" deleted.`, "info");
  } else {
    ctx.ui.notify(`Profile "${name}" not found.`, "error");
  }
}

/** Handle bare name: /profile <name> (alias for show). Returns true if handled. */
function handleBareName(sub: string, ctx: ProfileCommandContext): boolean {
  const profiles = loadProfiles(ctx.cwd);
  if (Object.hasOwn(profiles, sub)) {
    const profile = profiles[sub];
    if (profile) {
      ctx.ui.notify(formatProfileDetail(sub, profile), "info");
    }
    return true;
  }
  return false;
}

const SUBCOMMAND_RE = /^(list|show|create|edit|delete|ls|new|rm|remove)$/;

/**
 * Register the /profile command.
 */
export function registerProfileCommand(pi: ExtensionAPI): void {
  pi.registerCommand("profile", {
    description: "Manage subagent profiles (list, show, create, edit, delete)",

    getArgumentCompletions(prefix: string) {
      const profiles = loadProfiles();
      const subs = ["list", "show", "create", "edit", "delete"];
      const items = [...subs, ...Object.keys(profiles)]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },

    handler: async (args: string, ctx: ProfileCommandContext) => {
      const tokens = args.trim().split(/\s+/);
      const sub = tokens[0] ?? "list";

      if (sub === "list" || sub === "ls") {
        handleList(ctx);
        return;
      }
      if (sub === "show") {
        handleShow(tokens, ctx);
        return;
      }
      if (sub === "create" || sub === "new") {
        await handleCreate(tokens, ctx);
        return;
      }
      if (sub === "edit") {
        await handleEdit(tokens, ctx);
        return;
      }
      if (sub === "delete" || sub === "rm" || sub === "remove") {
        await handleDelete(tokens, ctx);
        return;
      }
      if (sub && !SUBCOMMAND_RE.test(sub) && handleBareName(sub, ctx)) {
        return;
      }

      ctx.ui.notify(
        "Usage: /profile [list|show <name>|create <name>|edit <name>|delete <name>]",
        "warning",
      );
    },
  });
}
