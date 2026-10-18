import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, apiError } from "../result.js";
import { COSTS, block, check, record } from "../quota.js";
import { clients, notAuth, videoUrl } from "../youtube.js";

const TOOL = "yt_search_public";

/**
 * yt_search_public - public YouTube search. EXPENSIVE: 100 units per call.
 * The server states cost + remaining before spending and refuses past the
 * 90% stop threshold. Public data only (no channel-private information).
 */
export function registerYtSearchPublic(server: McpServer): void {
  server.tool(
    TOOL,
    "Search PUBLIC YouTube videos (competitor/trend research). EXPENSIVE: costs 100 quota units per call. Returns video id, title, channel, publish date, URL. Never returns private data.",
    {
      query: z.string().min(2).describe("Search phrase."),
      max: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Results to return (default 10, max 50). One page - still 100 units."),
      order: z
        .enum(["relevance", "date", "viewCount", "rating"])
        .optional()
        .describe("Sort order (default relevance)."),
      includeStats: z
        .boolean()
        .optional()
        .describe("Fetch view counts for results (costs 1 extra unit per 50 results)."),
    },
    async ({ query, max, order, includeStats }) => {
      const c = clients();
      if (!c) return notAuth(TOOL);

      const qc = check(COSTS.search_list);
      if (!qc.allowed) {
        return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, {
          quota: qc,
        });
      }
      const spentBefore = qc.spent;
      const remainingBefore = qc.remaining;

      let units = 0;
      try {
        const res = await c.youtube.search.list({
          part: ["snippet"],
          q: query,
          type: ["video"],
          maxResults: max ?? 10,
          order: order ?? "relevance",
        });
        units += COSTS.search_list;

        const results = (res.data.items ?? [])
          .map((it) => ({
            videoId: it.id?.videoId ?? null,
            title: it.snippet?.title ?? "",
            channelId: it.snippet?.channelId ?? null,
            channelTitle: it.snippet?.channelTitle ?? "",
            publishedAt: it.snippet?.publishedAt ?? null,
            description: (it.snippet?.description ?? "").slice(0, 200),
            url: it.id?.videoId ? videoUrl(it.id.videoId) : null,
            views: null as number | null,
          }))
          .filter((r) => r.videoId);

        if (includeStats && results.length > 0) {
          const ids = results.map((r) => r.videoId!).slice(0, 50);
          const qc2 = check(COSTS.videos_list);
          if (qc2.allowed) {
            const vres = await c.youtube.videos.list({
              part: ["statistics"],
              id: ids,
            });
            units += COSTS.videos_list;
            const byId = new Map(
              (vres.data.items ?? []).map((v) => [
                v.id ?? "",
                Number(v.statistics?.viewCount ?? ""),
              ])
            );
            for (const r of results) {
              const v = byId.get(r.videoId!);
              if (v !== undefined && Number.isFinite(v)) r.views = v;
            }
          }
        }

        record(TOOL, units);
        return ok(TOOL, {
          query,
          returned: results.length,
          results,
          quota: block(units),
          costNotice: `This call cost ${units} units. Spent before: ${spentBefore}, remaining before: ${remainingBefore}.`,
        });
      } catch (e) {
        record(TOOL, units);
        return apiError(TOOL, e);
      }
    }
  );
}
