/**
 * Profile resolution logic for the delegate tool.
 *
 * Resolves profiles, validates tools/skills, and pre-resolves skill paths
 * for all tasks in a delegation request.
 */

import { loadSkills as discoverSkills } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "../constants";
import {
  applyExcludeTools,
  loadProfiles,
  resolveProfile,
  resolveProfileSkills,
  validateProfileSkills,
  validateProfileTools,
} from "../profiles";
import { resolvePackageSkillPaths } from "../skill-discovery";
import type { SubagentProfile } from "../profile-types";
import type { ProfileResolutionResult, ResolvedProfileEntry, StaticDelegateParams } from "./delegate-types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Profile Resolution ────────────────────────────────────────────────

/**
 * Apply tool exclude lists to resolved profiles.
 * Returns the list of all tool names (lazily computed).
 */
export function applyToolExcludeLists(
  resolvedProfiles: ResolvedProfileEntry[],
  pi: ExtensionAPI,
): string[] | undefined {
  let allToolNames: string[] | undefined;
  for (let i = 0; i < resolvedProfiles.length; i++) {
    const entry = resolvedProfiles[i];
    if (!entry) continue;
    const { name, profile } = entry;
    if (profile?.excludeTools && profile.excludeTools.length > 0) {
      if (!allToolNames) {
        allToolNames = pi.getAllTools().map((t) => t.name);
      }
      validateProfileTools(profile, name);
      resolvedProfiles[i] = { name, profile: applyExcludeTools(profile, allToolNames) };
    }
  }
  return allToolNames;
}

/**
 * Discover skills if any profile needs skill resolution.
 * Returns a skill map keyed by skill name, or undefined if no resolution needed.
 */
export async function discoverSkillsIfNeeded(
  resolvedProfiles: ResolvedProfileEntry[],
  cwd: string,
  agentDir: string,
): Promise<Map<string, { filePath: string; name: string; description: string }> | undefined> {
  const needsSkillResolution = resolvedProfiles.some(
    ({ profile }) => profile && (profile.suggestedSkills?.length || profile.loadSkills?.length),
  );
  if (!needsSkillResolution) return undefined;

  const packageSkillPaths = await resolvePackageSkillPaths(cwd, agentDir);
  const discResult = discoverSkills({
    cwd,
    agentDir,
    skillPaths: packageSkillPaths,
    includeDefaults: true,
  });
  return new Map(discResult.skills.map((s) => [s.name, s]));
}

/**
 * Pre-resolve skills for each unique profile to avoid repeated file reads.
 */
export async function preResolveProfileSkills(
  resolvedProfiles: ResolvedProfileEntry[],
  cwd: string,
  skillMap: Map<string, { filePath: string; name: string; description: string }> | undefined,
): Promise<
  Map<SubagentProfile, { ok: true; profile: SubagentProfile } | { ok: false; error: string }>
> {
  const skillResolvedProfiles = new Map<
    SubagentProfile,
    { ok: true; profile: SubagentProfile } | { ok: false; error: string }
  >();
  for (const { profile } of resolvedProfiles) {
    if (
      profile &&
      !skillResolvedProfiles.has(profile) &&
      (profile.suggestedSkills?.length || profile.loadSkills?.length)
    ) {
      try {
        skillResolvedProfiles.set(profile, {
          ok: true,
          profile: await resolveProfileSkills(profile, cwd, skillMap),
        });
      } catch (skillError) {
        skillResolvedProfiles.set(profile, {
          ok: false,
          error: skillError instanceof Error ? skillError.message : String(skillError),
        });
      }
    }
  }
  return skillResolvedProfiles;
}

/**
 * Resolve profiles, validate tools/skills, and pre-resolve skill paths
 * for all tasks in a delegation request.
 */
export async function resolveTaskProfiles(
  params: StaticDelegateParams,
  cwd: string,
  pi: ExtensionAPI,
): Promise<ProfileResolutionResult> {
  const profiles = loadProfiles(cwd);

  // Pre-resolve profiles for each task (avoids double resolution)
  const resolvedProfiles: ResolvedProfileEntry[] = params.tasks.map((t) => {
    const name = t.profile ?? params.profile;
    const profile = name ? resolveProfile(profiles, name) : undefined;
    return { name, profile };
  });

  const allToolNames = applyToolExcludeLists(resolvedProfiles, pi);

  // Validate skills in profiles
  for (const { name, profile } of resolvedProfiles) {
    if (profile) {
      validateProfileSkills(profile, name);
    }
  }

  const agentDir = getAgentDir();
  const skillMap = await discoverSkillsIfNeeded(resolvedProfiles, cwd, agentDir);
  const skillResolvedProfiles = await preResolveProfileSkills(resolvedProfiles, cwd, skillMap);

  return { profiles, resolvedProfiles, skillResolvedProfiles, allToolNames, agentDir };
}
