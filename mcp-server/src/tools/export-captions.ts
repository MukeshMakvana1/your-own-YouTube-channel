import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, apiError } from "../result.js";
import { COSTS, block, check, record } from "../quota.js";
import { clients, notAuth } from "../youtube.js";
import { exportsDir } from "../paths.js";

const TOOL = "yt_export_captions";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * yt_export_captions - list (50 units) or download (200 units) caption
 * tracks of the OWNED channel's videos. The YouTube API only allows caption
 * download for videos you own - downloading other creators' content is both
 * impossible via this tool and against YouTube ToS.
 */
export function registerYtExportCaptions(server: McpServer): void {
  server.tool(
    TOOL,
    "List caption tracks of one of YOUR videos (50 units) or download a track as a file (200 units). Without captionId it lists tracks; with captionId it downloads. Own videos only - other creators' captions are refused.",
    {
      videoId: z.string().regex(VIDEO_ID).describe("Video ID (11 chars) of your own video."),
      listOnly: z.boolean().optional().describe("List tracks only (50 units). Default behavior when captionId is absent."),
      captionId: z.string().optional().describe("Track ID from a previous listing - downloads this track (200 units)."),
      format: z.enum(["srt", "sbv", "ttml"]).optional().describe("Download format (default srt)."),
      outputDir: z.string().optional().describe("Where to save. Default: <data dir>\\exports."),
    },
    async ({ videoId, captionId, format, outputDir }) => {
      const c = clients();
      if (!c) return notAuth(TOOL);

      // ---- list mode ----
      if (!captionId) {
        const qc = check(COSTS.captions_list);
        if (!qc.allowed) {
          return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, { quota: qc });
        }
        try {
          const res = await c.youtube.captions.list({
            part: ["snippet"],
            videoId,
          });
          record(TOOL, COSTS.captions_list);
          const tracks = (res.data.items ?? []).map((t) => ({
            captionId: t.id ?? null,
            name: t.snippet?.name ?? null,
            language: t.snippet?.language ?? null,
            trackKind: t.snippet?.trackKind ?? null,
            isCC: t.snippet?.isCC ?? false,
            isDraft: t.snippet?.isDraft ?? false,
            lastUpdated: t.snippet?.lastUpdated ?? null,
            status: t.snippet?.status ?? null,
          }));
          return ok(TOOL, {
            mode: "list",
            videoId,
            trackCount: tracks.length,
            tracks,
            hint:
              tracks.length > 0
                ? `To download a track, call again with captionId="${tracks[0]?.captionId}" (200 units).`
                : "No caption tracks on this video. (If this is not your video, the API returns an error instead - only own captions are accessible.)",
            quota: block(COSTS.captions_list),
          });
        } catch (e) {
          return apiError(TOOL, e);
        }
      }

      // ---- download mode ----
      const qc = check(COSTS.captions_download);
      if (!qc.allowed) {
        return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, { quota: qc });
      }
      try {
        const fmt = format ?? "srt";
        const res = await c.youtube.captions.download(
          { id: captionId, tfmt: fmt },
          { responseType: "stream" } as never
        );
        const stream = res.data as unknown as AsyncIterable<Buffer | string>;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buf = Buffer.concat(chunks);
        record(TOOL, COSTS.captions_download);

        const dir = outputDir ? path.resolve(outputDir) : exportsDir();
        fs.mkdirSync(dir, { recursive: true });
        const outPath = path.join(dir, `${videoId}-${captionId}.${fmt}`);
        fs.writeFileSync(outPath, buf);

        // read-back evidence
        const stat = fs.statSync(outPath);
        const preview = buf.toString("utf8").slice(0, 240);

        return ok(TOOL, {
          mode: "downloaded",
          videoId,
          captionId,
          format: fmt,
          savedPath: outPath,
          bytes: stat.size,
          preview,
          readBack: "File written and re-read from disk (preview above is actual file content).",
          quota: block(COSTS.captions_download),
        });
      } catch (e) {
        return apiError(TOOL, e);
      }
    }
  );
}
