import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, apiError } from "../result.js";
import { COSTS, block, check, record } from "../quota.js";
import { clients, notAuth, videoUrl } from "../youtube.js";
import { projectState, setAudited } from "../project.js";

const TOOL = "yt_upload_video";

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024 * 1024; // YouTube cap: 256 GB
const THUMB_MAX = 2 * 1024 * 1024;

const VIDEO_EXT_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".ts": "video/mp2t",
};

const THUMB_EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/**
 * yt_upload_video - WRITE action. Requires confirm=true. 1600 units.
 * Rules enforced:
 *  - default privacyStatus = private;
 *  - 'public' refused unless the Google project is audited (approved);
 *  - after upload the ACTUAL privacy from YouTube is read back and reported;
 *  - if YouTube locks the upload private (audit restriction), that fact is
 *    recorded so future calls won't promise public.
 */
export function registerYtUploadVideo(server: McpServer): void {
  server.tool(
    TOOL,
    "Upload a video file to the owned channel. WRITE ACTION, 1600 quota units. Default dry-run validates the file and shows the exact payload; confirm=true uploads as PRIVATE (or unlisted/public only when the project is audited). Reports the ACTUAL privacy state read back from YouTube.",
    {
      filePath: z.string().min(1).describe("Absolute path to the video file on this machine."),
      title: z.string().min(1).max(100).describe("Video title (max 100 chars, no < or >).").refine((t) => !/[<>]/.test(t), "Title must not contain < or >."),
      description: z.string().max(5000).optional().describe("Description (max 5000 chars)."),
      tags: z.array(z.string()).optional().describe("Tags (total joined length max 500 chars)."),
      privacyStatus: z
        .enum(["private", "unlisted", "public"])
        .optional()
        .describe("Default private. 'public' requires an audited project; YouTube may still lock it private."),
      categoryId: z.string().optional().describe('Category ID (default "22" People & Blogs; "27" Education; "28" Sci & Tech).'),
      madeForKids: z.boolean().optional().describe("Self-declared made-for-kids (default false)."),
      publishAt: z
        .string()
        .optional()
        .describe('Schedule publish (ISO 8601, e.g. "2026-11-01T10:00:00Z"). Forces private until that time.'),
      thumbnailPath: z.string().optional().describe("Optional JPG/PNG (max 2 MB) set as thumbnail after upload (+50 units)."),
      confirm: z.boolean().optional().describe("Set true ONLY after user approved the exact payload. Default false = dry-run."),
    },
    async ({
      filePath, title, description, tags, privacyStatus, categoryId,
      madeForKids, publishAt, thumbnailPath, confirm,
    }) => {
      // ---- preflight: video file ----
      const ext = path.extname(filePath).toLowerCase();
      const mime = VIDEO_EXT_MIME[ext];
      if (!mime) {
        return fail(TOOL, "unsupported_format",
          `Extension "${ext}" is not a supported video container.`,
          `Supported: ${Object.keys(VIDEO_EXT_MIME).join(", ")}`);
      }
      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch {
        return fail(TOOL, "file_not_found", `Cannot read video file: ${filePath}`);
      }
      if (sizeBytes > MAX_UPLOAD_BYTES) {
        return fail(TOOL, "file_too_large", "File exceeds YouTube's 256 GB limit.");
      }
      if (tags) {
        const total = tags.map((t) => t.trim()).filter(Boolean).join(",").length;
        if (total > 500) {
          return fail(TOOL, "tags_exceed_limit", `Tags total ${total} chars; max 500 joined.`);
        }
      }

      // ---- privacy resolution ----
      let requested = privacyStatus ?? "private";
      let scheduled = false;
      if (publishAt) {
        scheduled = true;
        if (requested !== "private") {
          requested = "private"; // API requires private + publishAt
        }
      }
      if (requested === "public" && projectState().audited !== true) {
        return fail(TOOL, "public_not_allowed",
          "Project is NOT verified as audited, so a public upload is refused.",
          "Use private/unlisted now, or set YTAGENT_PROJECT_AUDITED=true only if YouTube approved your audit.");
      }

      const payload = {
        filePath,
        bytes: sizeBytes,
        mimeType: mime,
        snippet: {
          title,
          description: description ?? "",
          tags: tags?.map((t) => t.trim()).filter(Boolean) ?? [],
          categoryId: categoryId ?? "22",
        },
        status: {
          privacyStatus: requested,
          selfDeclaredMadeForKids: madeForKids ?? false,
          ...(publishAt ? { publishAt } : {}),
        },
        thumbnailPath: thumbnailPath ?? null,
      };

      // ---- thumbnail preflight (if any) ----
      if (thumbnailPath) {
        const tExt = path.extname(thumbnailPath).toLowerCase();
        const tMime = THUMB_EXT_MIME[tExt];
        if (!tMime) return fail(TOOL, "thumbnail_unsupported_format", `Thumbnail extension "${tExt}" not supported (use JPG/PNG).`);
        try {
          const tSize = fs.statSync(thumbnailPath).size;
          if (tSize > THUMB_MAX) return fail(TOOL, "thumbnail_too_large", "Thumbnail exceeds 2 MB.");
        } catch {
          return fail(TOOL, "thumbnail_not_found", `Cannot read thumbnail: ${thumbnailPath}`);
        }
      }

      if (!confirm) {
        return ok(TOOL, {
          mode: "dry-run",
          payload,
          scheduled,
          scheduleNote: scheduled
            ? "publishAt set: the video stays private until the scheduled time, then goes public automatically (requires audited project for public)."
            : null,
          willCall: "videos.insert (resumable upload)",
          cost: COSTS.videos_insert,
          note: "Nothing uploaded. Uploads take minutes for large files. Call again with confirm=true to start.",
        });
      }

      const qc = check(COSTS.videos_insert);
      if (!qc.allowed) {
        return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, { quota: qc });
      }
      const c = clients();
      if (!c) return notAuth(TOOL);

      let units = 0;
      try {
        const res = await c.youtube.videos.insert(
          {
            part: ["snippet", "status"],
            requestBody: { snippet: payload.snippet, status: payload.status },
            media: { mimeType: mime, body: fs.createReadStream(filePath) },
          },
          {
            onUploadProgress: (evt: unknown) => {
              const e = evt as { bytesRead?: number; loaded?: number };
              const sent = e.bytesRead ?? e.loaded ?? 0;
              // stderr only - stdout is the MCP protocol.
              process.stderr.write(`[ytagent] upload progress: ${sent}/${sizeBytes} bytes\n`);
            },
          }
        );
        units += COSTS.videos_insert;
        const videoId = res.data.id;
        if (!videoId) {
          record(TOOL, units);
          return fail(TOOL, "empty_response", "videos.insert returned no video id.");
        }

        // ---- read-back: actual stored privacy + processing state ----
        let actualPrivacy: string | null = res.data.status?.privacyStatus ?? null;
        let uploadStatus: string | null = null;
        let processingStatus: string | null = null;
        let readBackOk = false;
        try {
          const rb = await c.youtube.videos.list({
            part: ["status", "processingDetails", "snippet"],
            id: [videoId],
          });
          units += COSTS.videos_list;
          const v = rb.data.items?.[0];
          if (v) {
            readBackOk = true;
            actualPrivacy = v.status?.privacyStatus ?? actualPrivacy;
            uploadStatus = v.status?.uploadStatus ?? null;
            processingStatus = v.processingDetails?.processingStatus ?? null;
          }
        } catch {
          /* reported via readBackOk */
        }

        // ---- audit learning ----
        let privacyLocked = false;
        if (requested !== "private" && actualPrivacy === "private") {
          privacyLocked = true;
          setAudited(false);
        } else if (actualPrivacy === requested && requested !== "private") {
          setAudited(true);
        }

        // ---- optional thumbnail ----
        let thumbnailResult: Record<string, unknown> | null = null;
        if (thumbnailPath) {
          const qcT = check(COSTS.thumbnails_set);
          if (qcT.allowed) {
            const tMime = THUMB_EXT_MIME[path.extname(thumbnailPath).toLowerCase()];
            try {
              const tRes = await c.youtube.thumbnails.set({
                videoId,
                media: { mimeType: tMime, body: fs.createReadStream(thumbnailPath) },
              });
              units += COSTS.thumbnails_set;
              thumbnailResult = { set: true, maxres: tRes.data.items?.[0]?.maxres?.url ?? null };
            } catch (e) {
              thumbnailResult = { set: false, error: (e as Error).message };
            }
          } else {
            thumbnailResult = { set: false, error: "thumbnail quota guard blocked (+50 units needed)" };
          }
        }

        record(TOOL, units);
        return ok(TOOL, {
          mode: "uploaded",
          videoId,
          url: videoUrl(videoId),
          requestedPrivacy: requested,
          actualPrivacy,            // FACT, read back from YouTube
          privacyLocked,
          uploadStatus,
          processingStatus,
          readBackOk,
          thumbnail: thumbnailResult,
          costBreakdown: {
            videos_insert: COSTS.videos_insert,
            readback: readBackOk ? COSTS.videos_list : 0,
            thumbnail: thumbnailResult?.set ? COSTS.thumbnails_set : 0,
            total: units,
          },
          quota: block(units),
          warnings: [
            ...(privacyLocked
              ? ["YouTube LOCKED this upload to private despite the requested privacy - the Google project is not audited. The project flag has been updated so future calls won't over-promise."]
              : []),
            ...(!readBackOk
              ? ["Read-back failed; privacy state shown is from the upload response, not a fresh read."]
              : []),
          ],
        });
      } catch (e) {
        record(TOOL, units);
        return apiError(TOOL, e);
      }
    }
  );
}
