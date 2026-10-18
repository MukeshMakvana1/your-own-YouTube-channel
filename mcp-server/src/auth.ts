import fs from "node:fs";
import { OAuth2Client } from "google-auth-library";
import { clientSecretPath, tokenPath } from "./paths.js";

/**
 * OAuth 2.0 for ONE owned YouTube channel.
 *
 * Required scopes:
 *  - youtube.force-ssl        read/write own channel: videos, comments, captions, thumbnails, uploads
 *  - yt-analytics.readonly    YouTube Analytics reports
 *
 * Secrets (client_secret.json, token.json) live only in the data directory
 * (~/.ytagent by default) - never in this repo, never in tool output.
 */

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

interface ClientSecretShape {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

export function readClientSecret(): {
  clientId: string;
  clientSecret: string;
} | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(clientSecretPath(), "utf8")
    ) as ClientSecretShape;
    const c = raw.installed ?? raw.web;
    if (!c?.client_id || !c?.client_secret) return null;
    return { clientId: c.client_id, clientSecret: c.client_secret };
  } catch {
    return null;
  }
}

let cached: OAuth2Client | null = null;

/**
 * Returns an authorized OAuth2 client, or null when setup is incomplete
 * (missing client_secret.json or missing token.json -> run setup-auth).
 * Refreshed tokens are persisted back to token.json automatically.
 */
export function getOAuthClient(): OAuth2Client | null {
  if (cached) return cached;
  const creds = readClientSecret();
  if (!creds) return null;

  let token: Record<string, unknown>;
  try {
    token = JSON.parse(fs.readFileSync(tokenPath(), "utf8"));
  } catch {
    return null; // authorized not yet done
  }

  const client = new OAuth2Client({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  client.setCredentials(token);

  client.on("tokens", (t) => {
    try {
      const existing = JSON.parse(fs.readFileSync(tokenPath(), "utf8"));
      const merged: Record<string, unknown> = { ...existing, ...t };
      if (!t.refresh_token && existing.refresh_token) {
        merged.refresh_token = existing.refresh_token;
      }
      fs.writeFileSync(tokenPath(), JSON.stringify(merged, null, 2));
    } catch {
      /* non-fatal: next call will re-refresh */
    }
  });

  cached = client;
  return client;
}

export interface AuthState {
  clientSecretPresent: boolean;
  tokenPresent: boolean;
  authenticated: boolean;
  expiresAt: string | null;
  expired: boolean | null;
  scopes: string[] | null;
  missingScopes: string[];
}

/** Offline diagnostics - reads files only, never prints secret values. */
export function authState(): AuthState {
  const clientSecretPresent = readClientSecret() !== null;
  let token: Record<string, unknown> | null = null;
  try {
    token = JSON.parse(fs.readFileSync(tokenPath(), "utf8"));
  } catch {
    /* no token */
  }
  const scopeStr = typeof token?.scope === "string" ? token.scope : null;
  const scopes = scopeStr ? scopeStr.split(/\s+/).filter(Boolean) : null;
  const expiryMs =
    typeof token?.expiry_date === "number" ? token.expiry_date : null;
  const required = SCOPES;
  const missingScopes = scopes
    ? required.filter((s) => !scopes.includes(s))
    : required;
  return {
    clientSecretPresent,
    tokenPresent: token !== null,
    authenticated: clientSecretPresent && token !== null,
    expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
    expired: expiryMs !== null ? Date.now() > expiryMs : null,
    scopes,
    missingScopes: token !== null ? missingScopes : [],
  };
}
