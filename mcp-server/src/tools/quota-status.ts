import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok } from "../result.js";
import { block, snapshot } from "../quota.js";
import { authState, getOAuthClient } from "../auth.js";
import { projectState } from "../project.js";
import { cachedChannel } from "../youtube.js";

/**
 * yt_quota_status - session grounding tool. Costs 0 units.
 * Reports: local quota ledger, OAuth state, project audit flag, channel cache,
 * and optionally validates the token against Google (free, no data quota).
 */
export function registerYtQuotaStatus(server: McpServer): void {
  server.tool(
    "yt_quota_status",
    "Report remaining YouTube API quota (local ESTIMATE), OAuth auth state, and whether the Google project is audited for public uploads. Call this FIRST in every session. Costs 0 quota units.",
    {
      checkNetwork: z
        .boolean()
        .optional()
        .describe(
          "Also validate the OAuth token against Google (free; no Data API quota). Use when you need to confirm the token actually works."
        ),
    },
    async ({ checkNetwork }) => {
      const quota = snapshot();
      const auth = authState();
      const project = projectState();
      const channel = cachedChannel();

      let networkCheck: { tokenValid: boolean; error?: string } | null = null;
      if (checkNetwork) {
        const oauth = getOAuthClient();
        if (oauth) {
          try {
            await oauth.getAccessToken();
            networkCheck = { tokenValid: true };
          } catch (e) {
            networkCheck = { tokenValid: false, error: (e as Error).message };
          }
        } else {
          networkCheck = {
            tokenValid: false,
            error: "OAuth not configured or not authorized yet.",
          };
        }
      }

      const notes = [
        "Quota numbers are a LOCAL ESTIMATE for this Google Cloud project - other clients are not counted.",
        "Hard rule enforced by this server: refuse any spend past 90% of the daily limit.",
        "Uploads: privacyStatus=public only allowed when project.audited=true; otherwise YouTube keeps them locked private.",
      ];
      if (!auth.authenticated) {
        notes.push(
          'Not authorized yet. In a terminal: cd "mcp-server" folder, run `npm run setup-auth`, restart OpenCode.'
        );
      }
      if (auth.missingScopes.length > 0) {
        notes.push(
          `Token is missing scopes: ${auth.missingScopes.join(", ")}. Delete token.json and re-run setup-auth.`
        );
      }

      return ok("yt_quota_status", {
        quota,
        auth,
        project,
        channel,
        networkCheck,
        notes,
      });
    }
  );
}
