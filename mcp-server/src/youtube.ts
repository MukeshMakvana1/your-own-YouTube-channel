import fs from "node:fs";
import { google } from "googleapis";
import type { youtube_v3, youtubeAnalytics_v2 } from "googleapis";
import { getOAuthClient } from "./auth.js";
import { channelCachePath } from "./paths.js";
import { fail } from "./result.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface AuthedClients {
  youtube: youtube_v3.Youtube;
  analytics: youtubeAnalytics_v2.Youtubeanalytics;
}

/** Build authorized API clients, or null when OAuth setup is incomplete. */
export function clients(): AuthedClients | null {
  const oauth = getOAuthClient();
  if (!oauth) return null;
  return {
    youtube: google.youtube({ version: "v3", auth: oauth }),
    analytics: google.youtubeAnalytics({ version: "v2", auth: oauth }),
  };
}

/** Shared not-authenticated tool result. */
export function notAuth(tool: string): CallToolResult {
  return fail(
    tool,
    "not_authenticated",
    "Google OAuth is not set up for ytagent (missing client_secret.json or token.json).",
    'In a terminal: cd to the "mcp-server" folder, run `npm run setup-auth`, finish the browser consent, then restart OpenCode.'
  );
}

/* ------------------------------------------------------------------ */
/* Channel cache (id + uploads playlist) so cheap calls stay cheap     */
/* ------------------------------------------------------------------ */

export interface CachedChannel {
  id: string;
  title: string;
  uploadsPlaylistId: string | null;
  updatedAt: string;
}

export function cachedChannel(): CachedChannel | null {
  try {
    return JSON.parse(fs.readFileSync(channelCachePath(), "utf8"));
  } catch {
    return null;
  }
}

export function writeChannelCache(c: CachedChannel): void {
  fs.writeFileSync(channelCachePath(), JSON.stringify(c, null, 2));
}

/**
 * Fetch the authenticated user's channel (channels.list, 1 unit) and refresh
 * the local cache. Returns the API item.
 */
export async function fetchMyChannel(
  youtube: youtube_v3.Youtube
): Promise<youtube_v3.Schema$Channel | null> {
  const res = await youtube.channels.list({
    part: ["snippet", "statistics", "status", "contentDetails"],
    mine: true,
  });
  const item = res.data.items?.[0] ?? null;
  if (item?.id) {
    writeChannelCache({
      id: item.id,
      title: item.snippet?.title ?? "",
      uploadsPlaylistId:
        item.contentDetails?.relatedPlaylists?.uploads ?? null,
      updatedAt: new Date().toISOString(),
    });
  }
  return item;
}

/** Compact video URL helper. */
export const videoUrl = (id: string): string =>
  `https://www.youtube.com/watch?v=${id}`;
