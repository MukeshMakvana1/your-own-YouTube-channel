import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, apiError } from "../result.js";
import { COSTS, block, check, record } from "../quota.js";
import { cachedChannel, clients, fetchMyChannel, notAuth, videoUrl } from "../youtube.js";

const TOOL = "yt_list_videos";

interface LiteVideo {
  id: string;
  title: string;
  publishedAt: string;
  description: string;
  url: string;
  stats: Record<string, number | null> | null;
}

/**
 * yt_list_videos - recent uploads of the owned channel via the uploads
 * playlist (1 unit per 50 videos), optionally with per-video statistics
 * (1 extra unit per 50 videos). Much cheaper than search.list.
 */
export function registerYtListVideos(server: McpServer): void {
  server.tool(
    TOOL,
    "List the owned channel's recent videos via the uploads playlist: id, title, published date, URL. Optionally include view/like/comment counts. Costs 1 unit per 50 videos (plus 1 per 50 when stats requested).",
    {
      max: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum videos to return (default 20, max 200)."),
      includeStats: z
        .boolean()
        .optional()
        .describe(
          "Also fetch per-video view/like/comment counts (costs 1 extra unit per 50 videos)."
        ),
    },
    async ({ max, includeStats }) => {
      const c = clients();
      if (!c) return notAuth(TOOL);

      let units = 0;
      try {
        // Step 1: ensure we know the uploads playlist (cached from channel-stats).
        let ch = cachedChannel();
        if (!ch?.uploadsPlaylistId) {
          const qc = check(COSTS.channels_list);
          if (!qc.allowed) {
            return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, { quota: qc });
          }
          await fetchMyChannel(c.youtube);
          units += COSTS.channels_list;
          ch = cachedChannel();
          if (!ch?.uploadsPlaylistId) {
            record(TOOL, units);
            return fail(
              TOOL,
              "no_uploads_playlist",
              "Could not resolve the channel's uploads playlist.",
              "Run yt_channel_stats first, then retry."
            );
          }
        }

        // Step 2: page through the uploads playlist until `want` videos.
        const want = Math.min(max ?? 20, 200);
        const videos: LiteVideo[] = [];
        let pageToken: string | undefined;
        while (videos.length < want) {
          const qc = check(COSTS.playlist_items_list);
          if (!qc.allowed) {
            record(TOOL, units);
            return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, {
              quota: block(units),
              partial: videos,
            });
          }
          const perPage = Math.min(50, want - videos.length);
          const res = await c.youtube.playlistItems.list({
            part: ["snippet", "contentDetails"],
            playlistId: ch.uploadsPlaylistId,
            maxResults: perPage,
            pageToken,
          });
          units += COSTS.playlist_items_list;
          for (const it of res.data.items ?? []) {
            const vid = it.contentDetails?.videoId;
            if (!vid) continue;
            videos.push({
              id: vid,
              title: it.snippet?.title ?? "",
              publishedAt: it.snippet?.publishedAt ?? "",
              description: (it.snippet?.description ?? "").slice(0, 300),
              url: videoUrl(vid),
              stats: null,
            });
          }
          pageToken = res.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }

        // Step 3: optional statistics (chunked, 50 ids per unit).
        if (includeStats && videos.length > 0) {
          const ids = videos.map((v) => v.id);
          for (let i = 0; i < ids.length; i += 50) {
            const chunk = ids.slice(i, i + 50);
            const qc = check(COSTS.videos_list);
            if (!qc.allowed) {
              record(TOOL, units);
              return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, {
                quota: block(units),
                partial: videos,
              });
            }
            const res = await c.youtube.videos.list({
              part: ["statistics"],
              id: chunk,
            });
            units += COSTS.videos_list;
            const statsById = new Map(
              (res.data.items ?? []).map((v) => [v.id ?? "", v.statistics])
            );
            for (const v of videos) {
              const st = statsById.get(v.id);
              if (st) {
                v.stats = {
                  views: toNum(st.viewCount),
                  likes: toNum(st.likeCount),
                  comments: toNum(st.commentCount),
                };
              }
            }
          }
        }

        record(TOOL, units);
        return ok(TOOL, {
          channel: { id: ch.id, title: ch.title },
          returned: videos.length,
          videos,
          quota: block(units),
        });
      } catch (e) {
        record(TOOL, units);
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
