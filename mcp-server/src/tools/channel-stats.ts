import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, apiError } from "../result.js";
import { COSTS, block, check, record } from "../quota.js";
import { clients, fetchMyChannel, notAuth } from "../youtube.js";

const TOOL = "yt_channel_stats";

/**
 * yt_channel_stats - the authenticated channel's ID, title, statistics and
 * uploads playlist. 1 quota unit (channels.list). Also refreshes the local
 * channel cache used by cheaper tools.
 */
export function registerYtChannelStats(server: McpServer): void {
  server.tool(
    TOOL,
    "Get the owned channel's ID, title, subscriber/video/view counts, channel privacy status and uploads playlist ID. Costs 1 quota unit. Refreshes the local channel cache.",
    {},
    async () => {
      const c = clients();
      if (!c) return notAuth(TOOL);
      try {
        const qc = check(COSTS.channels_list);
        if (!qc.allowed) {
          return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, {
            quota: qc,
          });
        }
        const item = await fetchMyChannel(c.youtube);
        record(TOOL, COSTS.channels_list);
        if (!item?.id) {
          return fail(
            TOOL,
            "no_channel",
            "The authorized Google account has no YouTube channel.",
            "Authorize with the Google account that owns the channel (re-run setup-auth)."
          );
        }
        const s = item.statistics;
        return ok(TOOL, {
          id: item.id,
          title: item.snippet?.title ?? null,
          customUrl: item.snippet?.customUrl ?? null,
          publishedAt: item.snippet?.publishedAt ?? null,
          country: item.snippet?.country ?? null,
          stats: {
            subscribers: s?.hiddenSubscriberCount
              ? null
              : toNum(s?.subscriberCount),
            subscribersHidden: s?.hiddenSubscriberCount ?? false,
            videos: toNum(s?.videoCount),
            views: toNum(s?.viewCount),
          },
          channelPrivacyStatus: item.status?.privacyStatus ?? null,
          uploadsPlaylistId:
            item.contentDetails?.relatedPlaylists?.uploads ?? null,
          quota: block(COSTS.channels_list),
        });
      } catch (e) {
        return apiError(TOOL, e);
      }
    }
  );
}

function toNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
