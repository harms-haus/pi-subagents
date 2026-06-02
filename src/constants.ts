import { join } from "node:path";
import { homedir } from "node:os";

export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
