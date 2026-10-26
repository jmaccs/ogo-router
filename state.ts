import { homedir } from "node:os";
import { join } from "node:path";

export function getDataDir(): string {
  return process.env.OGO_ROUTER_DATA_DIR ?? join(homedir(), ".pi", "agent");
}

export function getStateFile(dataDir = getDataDir()): string {
  return join(dataDir, `ogo-dashboard-${process.pid}.json`);
}
