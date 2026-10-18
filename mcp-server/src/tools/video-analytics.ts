import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, apiError } from "../result.js";
import { block } from "../quota.js";
import { clients, notAuth } from "../youtube.js";

const TOOL = "yt_video_analytics";

const DEFAULT_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  return isoDate(new Date(Date.now() - n * 86_400_000));
}

/**
 * yt_video_analytics - YouTube Analytics API v2 reports.query for the owned
 * channel. The Analytics API has its OWN quota (separate from the 10,000
 * Data API units) and is therefore not counted in the local ledger.
 */
export function registerYtVideoAnalytics(server: McpServer): void {
  server.tool(
    TOOL,
    "Query the owned channel's YouTube Analytics (views, watch time, average duration/percentage, impressions, CTR) via the Analytics API. Optionally filter to specific videos. Does NOT consume Data API quota - Analytics API has its own separate quota.",
    {
      videoIds: z
        .array(z.string())
        .max(200)
        .optional()
        .describe(
          "Restrict to specific video IDs (e.g. top/bottom CTR analyses). Omit for channel-wide data."
        ),
      startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("YYYY-MM-DD. Default: 28 days ago."),
      endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("YYYY-MM-DD. Default: today."),
      metrics: z
        .array(z.string())
        .optional()
        .describe(
          `Comma-list of metrics. Default: ${DEFAULT_METRICS.join(", ")}. Also common: "impressions", "impressionClickThroughRate", "subscribersGained", "subscribersLost", "likes", "comments".`
        ),
      dimensions: z
        .array(z.string())
        .optional()
        .describe(
          'Breakdown dimensions, e.g. ["day"], ["video"], ["country"]. Omit for totals only.'
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max rows returned (default 50, max 200)."),
    },
    async ({ videoIds, startDate, endDate, metrics, dimensions, maxResults }) => {
      const c = clients();
      if (!c) return notAuth(TOOL);
      try {
        const effectiveStart = startDate ?? daysAgo(28);
        const effectiveEnd = endDate ?? isoDate(new Date());
        const effectiveMetrics =
          metrics && metrics.length > 0 ? metrics : DEFAULT_METRICS;
        const res = await c.analytics.reports.query({
          ids: "channel==MINE",
          startDate: effectiveStart,
          endDate: effectiveEnd,
          metrics: effectiveMetrics.join(","),
          ...(dimensions && dimensions.length > 0
            ? { dimensions: dimensions.join(",") }
            : {}),
          ...(videoIds && videoIds.length > 0
            ? { filters: `video==${videoIds.join(",")}` }
            : {}),
          maxResults: maxResults ?? 50,
        });
        return ok(TOOL, {
          dateRange: { startDate: effectiveStart, endDate: effectiveEnd },
          metrics: effectiveMetrics,
          dimensions: dimensions ?? [],
          columnHeaders: (res.data.columnHeaders ?? []).map(
            (h: {
              name?: string | null;
              dataType?: string | null;
              columnType?: string | null;
            }) => ({
              name: h.name ?? null,
              dataType: h.dataType ?? null,
              columnType: h.columnType ?? null,
            })
          ),
          rows: res.data.rows ?? [],
          quota: block(0),
          analyticsNote:
            "Analytics API quota is separate from the Data API 10k units and is not tracked in the local ledger.",
        });
      } catch (e) {
        return apiError(TOOL, e);
      }
    }
  );
}
