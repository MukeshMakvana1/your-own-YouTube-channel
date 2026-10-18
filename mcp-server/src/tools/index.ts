import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerYtQuotaStatus } from "./quota-status.js";
import { registerYtChannelStats } from "./channel-stats.js";
import { registerYtListVideos } from "./list-videos.js";
import { registerYtVideoAnalytics } from "./video-analytics.js";
import { registerYtSearchPublic } from "./search-public.js";
import { registerYtGetComments } from "./get-comments.js";
import { registerYtReplyComment } from "./reply-comment.js";
import { registerYtUpdateMetadata } from "./update-metadata.js";
import { registerYtSetThumbnail } from "./set-thumbnail.js";
import { registerYtExportCaptions } from "./export-captions.js";
import { registerYtUploadVideo } from "./upload-video.js";

/** Register all 11 ytagent tools on the MCP server. */
export function registerAll(server: McpServer): void {
  registerYtQuotaStatus(server);
  registerYtChannelStats(server);
  registerYtListVideos(server);
  registerYtVideoAnalytics(server);
  registerYtSearchPublic(server);
  registerYtGetComments(server);
  registerYtReplyComment(server);
  registerYtUpdateMetadata(server);
  registerYtSetThumbnail(server);
  registerYtExportCaptions(server);
  registerYtUploadVideo(server);
}
