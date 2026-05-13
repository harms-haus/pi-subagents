/**
 * /profile Slash Command
 *
 * Command registration for managing subagent profiles.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { editProfileInteractive } from "../profile-editor";
import { deleteProfile, formatProfileDetail, loadProfiles, profileSummary } from "../profiles";

/**
 * Register the /profile command.
 */
export function registerProfileCommand(pi: ExtensionAPI): void {
  pi.registerCommand("profile", {
    description: "Manage subagent profiles (list, show, create, edit, delete)",

    async getArgumentCompletions(prefix: string) {
      const profiles = await loadProfiles();
      const subs = ["list", "show", "create", "edit", "delete"];
      const items = [...subs, ...Object.keys(profiles)]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },

    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);
      const sub = tokens[0] ?? "list";

      // ── /profile list ──
      if (sub === "list" || sub === "ls") {
        const profiles = await loadProfiles(ctx.cwd);
        const names = Object.keys(profiles);
        if (names.length === 0) {
          ctx.ui.notify(
            "No subagent profiles found. Add .md files to ~/.pi/agent/agent-profiles/ or use /profile create.",
            "info",
          );
          return;
        }
        const lines = names.map((n) => `  ${profileSummary(n, profiles[n])}`);
        ctx.ui.notify(`Subagent profiles:\n${lines.join("\n")}`, "info");
        return;
      }

      // ── /profile show <name> ──
      if (sub === "show") {
        const name = tokens[1];
        if (!name) {
          ctx.ui.notify("Usage: /profile show <name>", "warning");
          return;
        }
        const profiles = await loadProfiles(ctx.cwd);
        const profile = profiles[name];
        if (!profile) {
          ctx.ui.notify(
            `Profile "${name}" not found. Available: ${Object.keys(profiles).join(", ") || "(none)"}`,
            "error",
          );
          return;
        }
        ctx.ui.notify(formatProfileDetail(name, profile), "info");
        return;
      }

      // ── /profile create <name> ──
      if (sub === "create" || sub === "new") {
        const name = tokens[1];
        if (!(name && /^[a-zA-Z0-9_-]+$/.test(name))) {
          ctx.ui.notify("Usage: /profile create <name>  (alphanumeric, hyphens, underscores)", "warning");
          return;
        }
        const profiles = await loadProfiles(ctx.cwd);
        if (profiles[name]) {
          ctx.ui.notify(`Profile "${name}" already exists. Use /profile edit ${name} to modify it.`, "warning");
          return;
        }
        await editProfileInteractive(name, {}, ctx);
        return;
      }

      // ── /profile edit <name> ──
      if (sub === "edit") {
        const name = tokens[1];
        if (!name) {
          ctx.ui.notify("Usage: /profile edit <name>", "warning");
          return;
        }
        const profiles = await loadProfiles(ctx.cwd);
        const profile = profiles[name];
        if (!profile) {
          ctx.ui.notify(`Profile "${name}" not found. Use /profile create ${name} to create it.`, "error");
          return;
        }
        await editProfileInteractive(name, { ...profile }, ctx);
        return;
      }

      // ── /profile delete <name> ──
      if (sub === "delete" || sub === "rm" || sub === "remove") {
        const name = tokens[1];
        if (!name) {
          ctx.ui.notify("Usage: /profile delete <name>", "warning");
          return;
        }
        const ok = await ctx.ui.confirm("Delete profile?", `Delete subagent profile "${name}"?`);
        if (!ok) return;
        const deleted = await deleteProfile(name, "global");
        const deletedProject = await deleteProfile(name, "project", ctx.cwd);
        if (deleted || deletedProject) {
          ctx.ui.notify(`Profile "${name}" deleted.`, "info");
        } else {
          ctx.ui.notify(`Profile "${name}" not found.`, "error");
        }
        return;
      }

      // ── Bare name: /profile <name> (alias for show) ──
      if (sub && !/^(list|show|create|edit|delete|ls|new|rm|remove)$/.test(sub)) {
        const profiles = await loadProfiles(ctx.cwd);
        const profile = profiles[sub];
        if (profile) {
          ctx.ui.notify(formatProfileDetail(sub, profile), "info");
          return;
        }
      }

      ctx.ui.notify("Usage: /profile [list|show <name>|create <name>|edit <name>|delete <name>]", "warning");
    },
  });
}
