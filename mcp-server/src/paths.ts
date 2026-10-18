import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * All runtime state (token, client secret, quota ledger, caches, exports)
 * lives OUTSIDE this repo in a single data directory so secrets can never
 * be committed to git.
 */
export function dataDir(): string {
  const dir =
    process.env.YTAGENT_DATA_DIR?.trim() || path.join(os.homedir(), ".ytagent");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const tokenPath = (): string => path.join(dataDir(), "token.json");

export const clientSecretPath = (): string =>
  process.env.YTAGENT_CLIENT_SECRETS_FILE?.trim() ||
  path.join(dataDir(), "client_secret.json");

export const quotaPath = (): string => path.join(dataDir(), "quota.json");

export const projectPath = (): string => path.join(dataDir(), "project.json");

export const channelCachePath = (): string =>
  path.join(dataDir(), "channel.json");

export const exportsDir = (): string => {
  const dir = path.join(dataDir(), "exports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
