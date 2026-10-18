import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, apiError } from "../result.js";
import { COSTS, block, check, record } from "../quota.js";
import { clients, notAuth } from "../youtube.js";

const TOOL = "yt_reply_comment";

/**
 * yt_reply_comment - WRITE action. Requires confirm=true.
 * Without confirm it returns a dry-run of the exact payload (no write).
 * With confirm it posts the reply (50 units) then READS BACK the stored
 * comment (1 unit) so completion is proven with real data.
 */
export function registerYtReplyComment(server: McpServer): void {
  server.tool(
    TOOL,
    "Reply to a comment on a video. WRITE ACTION - public immediately. Without confirm=true it only returns a dry-run of the exact payload; call again with confirm=true after user approval. Costs 50 units + 1 for read-back.",
    {
      parentId: z
        .string()
        .min(1)
        .describe(
          "ID of the comment being replied to: topLevelCommentId from yt_get_comments for top-level comments, or commentId for replies."
        ),
      text: z.string().min(1).max(10000).describe("Reply text (as the channel)."),
      confirm: z
        .boolean()
        .optional()
        .describe("Set true ONLY after the user explicitly approved this exact reply. Default false = dry-run."),
    },
    async ({ parentId, text, confirm }) => {
      if (!confirm) {
        const qc = check(COSTS.comments_insert);
        return ok(TOOL, {
          mode: "dry-run",
          willCall: "comments.insert",
          cost: COSTS.comments_insert,
          payload: { snippet: { parentId, textOriginal: text } },
          warning:
            "This reply will be PUBLIC immediately and visible as the channel. Call again with confirm=true to execute.",
          quota: qc,
        });
      }

      const qc = check(COSTS.comments_insert);
      if (!qc.allowed) {
        return fail(TOOL, "quota_guard", qc.reason ?? "quota blocked", undefined, { quota: qc });
      }
      const c = clients();
      if (!c) return notAuth(TOOL);

      let units = 0;
      try {
        const res = await c.youtube.comments.insert({
          part: ["snippet"],
          requestBody: { snippet: { parentId, textOriginal: text } },
        });
        units += COSTS.comments_insert;
        const newId = res.data.id;
        if (!newId) {
          record(TOOL, units);
          return fail(TOOL, "empty_response", "comments.insert returned no comment id.");
        }

        // Read-back: prove the stored value.
        let stored: Record<string, unknown> | null = null;
        try {
          const rb = await c.youtube.comments.list({
            part: ["snippet"],
            id: [newId],
          });
          units += COSTS.comments_list;
          const item = rb.data.items?.[0];
          stored = item
            ? {
                id: item.id,
                textOriginal: item.snippet?.textOriginal,
                authorDisplayName: item.snippet?.authorDisplayName,
                publishedAt: item.snippet?.publishedAt,
                likeCount: item.snippet?.likeCount,
                moderationStatus: item.snippet?.moderationStatus ?? "published",
              }
            : null;
        } catch {
          /* read-back failure is reported below, not fatal */
        }

        record(TOOL, units);
        return ok(TOOL, {
          created: true,
          commentId: newId,
          readBack: stored,
          readBackOk: stored !== null,
          quota: block(units),
          warning:
            "Reply posted as the channel. Verify with the read-back above - that is the stored value.",
        });
      } catch (e) {
        record(TOOL, units);
        return apiError(TOOL, e);
      }
    }
  );
}
