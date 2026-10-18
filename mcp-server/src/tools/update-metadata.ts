import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, apiError } from "../result.js";
import { COSTS, block, check, record } from "../quota.js";
import { clients, notAuth } from "../youtube.js";
import { projectState } from "../project.js";

const TOOL = "yt_update_metadata";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * yt_update_metadata - WRITE action. Requires confirm=true.
 * Dry-run (default): fetches current values (1 unit) and shows a precise
 * before/after diff. Confirm: validates, writes (50 units), then READS BACK
 * the stored values (1 unit).
 */
export function registerYtUpdateMetadata(server: McpServer): void {
  server.tool(
    TOOL,
    "Update a video's title, description, tags, category or privacy on the owned channel. WRITE ACTION. Default is a dry-run with a before/after diff; set confirm=true to execute after user approval. Costs 1 (read) + 50 (write) + 1 (read-back) units.",
    {
      videoId: z.string().regex(VIDEO_ID).describe("Video ID (11 chars)."),
      title: z.string().optional().describe("New title (max 100 chars, no < or >)."),
      description: z.string().optional().describe("New description (max 5000 chars)."),
      tags: z.array(z.string()).optional().describe("Full replacement tag list (total joined length max 500 chars)."),
      categoryId: z.string().optional().describe('Category ID, e.g. "22" (People & Blogs), "27" (Education), "28" (Sci & Tech).'),
      privacyStatus: z
        .enum(["private", "unlisted", "public"])
        .optional()
        .describe("'public' only allowed when the Google project is audited."),
      confirm: z.boolean().optional().describe("Set true ONLY after user approved the exact diff. Default false = dry-run."),
    },
    async ({ videoId, title, description, tags, categoryId, privacyStatus, confirm }) => {
      // ---- validation (fail before spending anything) ----
      const hasChange = [title, description, tags, categoryId, privacyStatus].some(
        (v) => v !== undefined
      );
      if (!hasChange) {
        return fail(TOOL, "nothing_to_update", "No fields provided.",
          "Provide at least one of: title, description, tags, categoryId, privacyStatus.");
      }
      if (title !== undefined) {
        if (title.length > 100) return fail(TOOL, "title_too_long", `Title is ${title.length} chars; YouTube max is 100.`);
        if (/[<>]/.test(title)) return fail(TOOL, "invalid_characters", "Title must not contain < or > (YouTube rejects them).");
      }
      if (description !== undefined && description.length > 5000) {
        return fail(TOOL, "description_too_long", `Description is ${description.length} chars; YouTube max is 5000.`);
      }
      if (tags !== undefined) {
        const clean = tags.map((t) => t.trim()).filter(Boolean);
        const total = clean.join(",").length;
        if (total > 500) {
          return fail(TOOL, "tags_exceed_limit", `Tags total ${total} chars; YouTube max is 500 joined.`,
            "Trim the list (target <=15 focused tags).");
        }
      }
      if (privacyStatus === "public" && projectState().audited !== true) {
        return fail(TOOL, "public_not_allowed",
          "Project is NOT verified as audited, so public visibility is refused.",
          "Only set YTAGENT_PROJECT_AUDITED=true if YouTube approved your audit. Otherwise use unlisted/private.");
      }

      const c = clients();
      if (!c) return notAuth(TOOL);

      let units = 0;
      try {
        // ---- read current (always, for the diff and for safe merging) ----
        const qcRead = check(COSTS.videos_list);
        if (!qcRead.allowed) return fail(TOOL, "quota_guard", qcRead.reason ?? "quota blocked", undefined, { quota: qcRead });
        const curRes = await c.youtube.videos.list({
          part: ["snippet", "status"],
          id: [videoId],
        });
        units += COSTS.videos_list;
        const cur = curRes.data.items?.[0];
        if (!cur) {
          record(TOOL, units);
          return fail(TOOL, "video_not_found", `No video with id ${videoId} found on this channel (or it is not accessible).`);
        }

        const before = {
          title: cur.snippet?.title ?? null,
          description: cur.snippet?.description ?? null,
          tags: cur.snippet?.tags ?? [],
          categoryId: cur.snippet?.categoryId ?? null,
          privacyStatus: cur.status?.privacyStatus ?? null,
        };
        const after = {
          title: title ?? before.title,
          description: description ?? before.description,
          tags: tags !== undefined ? tags.map((t) => t.trim()).filter(Boolean) : before.tags,
          categoryId: categoryId ?? before.categoryId,
          privacyStatus: privacyStatus ?? before.privacyStatus,
        };
        const diff = Object.fromEntries(
          (Object.keys(after) as Array<keyof typeof after>)
            .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
            .map((k) => [k, { before: before[k], after: after[k] }])
        );

        if (!confirm) {
          record(TOOL, units);
          return ok(TOOL, {
            mode: "dry-run",
            videoId,
            diff,
            willCall: "videos.update",
            cost: COSTS.videos_update,
            note: "Nothing written. Call again with confirm=true to apply this exact diff.",
            quota: block(units),
          });
        }

        // ---- write ----
        if (Object.keys(diff).length === 0) {
          record(TOOL, units);
          return ok(TOOL, { mode: "no-op", videoId, message: "Proposed values equal current values; nothing to write.", diff, quota: block(units) });
        }
        const qcWrite = check(COSTS.videos_update);
        if (!qcWrite.allowed) {
          record(TOOL, units);
          return fail(TOOL, "quota_guard", qcWrite.reason ?? "quota blocked", undefined, { quota: qcWrite });
        }
        const part: string[] = ["snippet"];
        const requestBody: Record<string, unknown> = {
          id: videoId,
          snippet: {
            title: after.title,
            description: after.description,
            tags: after.tags,
            categoryId: after.categoryId,
          },
        };
        if (privacyStatus !== undefined) {
          part.push("status");
          requestBody.status = { privacyStatus: after.privacyStatus };
        }
        await c.youtube.videos.update({
          part,
          requestBody: requestBody as never,
        });
        units += COSTS.videos_update;

        // ---- read-back ----
        let stored: Record<string, unknown> | null = null;
        try {
          const rb = await c.youtube.videos.list({
            part: ["snippet", "status"],
            id: [videoId],
          });
          units += COSTS.videos_list;
          const v = rb.data.items?.[0];
          stored = v
            ? {
                title: v.snippet?.title,
                description: v.snippet?.description,
                tags: v.snippet?.tags ?? [],
                categoryId: v.snippet?.categoryId,
                privacyStatus: v.status?.privacyStatus,
              }
            : null;
        } catch {
          /* reported below */
        }

        record(TOOL, units);
        return ok(TOOL, {
          mode: "written",
          videoId,
          diff,
          readBack: stored,
          readBackOk: stored !== null,
          note: "readBack above is the value actually stored on YouTube now.",
          quota: block(units),
        });
      } catch (e) {
        record(TOOL, units);
        return apiError(TOOL, e);
      }
    }
  );
}
