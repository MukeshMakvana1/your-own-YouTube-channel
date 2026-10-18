import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, apiError } from "../result.js";
import { COSTS, block, check, record } from "../quota.js";
import { clients, notAuth } from "../youtube.js";

const TOOL = "yt_set_thumbnail";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_BYTES = 2 * 1024 * 1024; // YouTube thumbnail hard limit: 2 MB

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/**
 * yt_set_thumbnail - WRITE action. Requires confirm=true.
 * Preflight (file exists, allowed format, <=2 MB) runs even in dry-run.
 */
export function registerYtSetThumbnail(server: McpServer): void {
  server.tool(
    TOOL,
    "Set a video's thumbnail from a local image (JPG/PNG/GIF/BMP, max 2 MB). WRITE ACTION. Default returns a dry-run with file checks; set confirm=true to execute after approval. Costs 50 units.",
    {
      videoId: z.string().regex(VIDEO_ID).describe("Video ID (11 chars)."),
      imagePath: z.string().min(1).describe("Absolute path to the image file on this machine."),
      confirm: z.boolean().optional().describe("Set true ONLY after user approved this exact image. Default false = dry-run."),
    },
    async ({ videoId, imagePath, confirm }) => {
      // ---- preflight (no API cost) ----
      const ext = path.extname(imagePath).toLowerCase();
      const mime = EXT_MIME[ext];
      if (!mime) {
        return fail(TOOL, "unsupported_format", `Extension "${ext}" is not supported.`,
          "Use JPG, PNG, GIF or BMP (YouTube accepts JPG/PNG most reliably).");
      }
      let size: number;
      try {
        size = fs.statSync(imagePath).size;
      } catch {
        return fail(TOOL, "file_not_found", `Cannot read file: ${imagePath}`);
      }
      if (size > MAX_BYTES) {
        return fail(TOOL, "thumbnail_too_large", `Image is ${(size / 1024 / 1024).toFixed(2)} MB; YouTube max is 2 MB.`,
          "Compress or resize to <= 1280x720 and retry.");
      }

      if (!confirm) {
        return ok(TOOL, {
          mode: "dry-run",
          videoId,
          image: { path: imagePath, bytes: size, mimeType: mime },
          willCall: "thumbnails.set",
          cost: COSTS.thumbnails_set,
          warning: "Replaces the current thumbnail immediately. Call again with confirm=true to execute.",
        });
      }

      const qc = check(COSTS.thumbnails_set);
      if (!qc.allowed) {
        return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, { quota: qc });
      }
      const c = clients();
      if (!c) return notAuth(TOOL);

      try {
        const res = await c.youtube.thumbnails.set({
          videoId,
          media: { mimeType: mime, body: fs.createReadStream(imagePath) },
        });
        record(TOOL, COSTS.thumbnails_set);
        const thumbs = res.data.items?.[0] ?? null;
        return ok(TOOL, {
          mode: "written",
          videoId,
          image: { path: imagePath, bytes: size, mimeType: mime },
          readBack: "thumbnails.set returned the thumbnail set below (this is the stored state).",
          thumbnails: thumbs
            ? {
                default: thumbs.default?.url ?? null,
                medium: thumbs.medium?.url ?? null,
                high: thumbs.high?.url ?? null,
                standard: thumbs.standard?.url ?? null,
                maxres: thumbs.maxres?.url ?? null,
              }
            : null,
          note: "CDN propagation can take a few minutes; the URL may 404 briefly right after set.",
          quota: block(COSTS.thumbnails_set),
        });
      } catch (e) {
        return apiError(TOOL, e);
      }
    }
  );
}
