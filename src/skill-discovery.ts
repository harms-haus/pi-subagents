import { homedir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { TtlCache } from "./cache";

const skillCache = new TtlCache<string[]>(5000);

export function invalidatePackageSkillCache(): void {
  skillCache.invalidate();
}

export async function resolvePackageSkillPaths(cwd: string, agentDir?: string): Promise<string[]> {
  const cached = skillCache.get(cwd);
  if (cached) {
    return cached;
  }

  const resolvedAgentDir = agentDir ?? join(homedir(), ".pi", "agent");
  const settingsManager = SettingsManager.create(cwd, resolvedAgentDir);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir: resolvedAgentDir,
    settingsManager,
  });
  const resolvedPaths = await packageManager.resolve();
  const paths = resolvedPaths.skills.filter((s) => s.enabled).map((s) => s.path);

  skillCache.set(cwd, paths);
  return paths;
}
