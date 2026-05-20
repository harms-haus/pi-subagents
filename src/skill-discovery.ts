import { homedir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

let packageSkillCache: { cwd: string; paths: string[]; timestamp: number } | null = null;
const CACHE_TTL = 5000; // 5 seconds

export function invalidatePackageSkillCache(): void {
  packageSkillCache = null;
}

export async function resolvePackageSkillPaths(cwd: string, agentDir?: string): Promise<string[]> {
  const now = Date.now();
  if (packageSkillCache && packageSkillCache.cwd === cwd && now - packageSkillCache.timestamp < CACHE_TTL) {
    return packageSkillCache.paths;
  }

  const resolvedAgentDir = agentDir ?? join(homedir(), ".pi", "agent");
  const settingsManager = SettingsManager.create(cwd, resolvedAgentDir);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir: resolvedAgentDir,
    settingsManager,
  });
  const resolvedPaths = await packageManager.resolve();
  const paths = resolvedPaths.skills
    .filter((s) => s.enabled)
    .map((s) => s.path);

  packageSkillCache = { cwd, paths, timestamp: now };
  return paths;
}
