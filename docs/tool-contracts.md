# ytagent tool contracts

Every tool returns a single JSON document in `content[0].text`:
`{ ok, tool, summary?, data }` on success, `{ ok, tool, error: { code, message, hint? } }` on failure (`isError: true`).
`data` includes a `quota` block: `{ usedThisCall, spentToday, callsToday, remainingToday, limit, stopAt, note }` (local ESTIMATE).

---

## yt_quota_status (0 units)

**Params:** `checkNetwork?: boolean` (also validates the token against Google; free).
**Returns (data):** `quota` (ledger snapshot), `auth` (`clientSecretPresent`, `tokenPresent`, `authenticated`, `expiresAt`, `expired`, `scopes`, `missingScopes` - no secret values), `project` (`audited: true|false|null`, `source: env|observed|default`), `channel` (cached id/title/uploadsPlaylistId), `networkCheck`, `notes[]`.
**Use:** first call of every session.

## yt_channel_stats (1 unit)

**Params:** none.
**Returns:** `id`, `title`, `customUrl`, `publishedAt`, `country`, `stats { subscribers (null if hidden), videos, views }`, `channelPrivacyStatus`, `uploadsPlaylistId`.
**Side effect:** refreshes `~/.ytagent/channel.json` cache.

## yt_list_videos (1 unit per 50 videos)

**Params:** `max?: 1..200` (default 20), `includeStats?: boolean` (+1 unit per 50).
**Returns:** `channel {id,title}`, `returned`, `videos[] { id, title, publishedAt, description(300 chars), url, stats|null { views, likes, comments } }`.
**Notes:** pages the uploads playlist (cheap). Uses cached channel; fetches it (+1) on first run.

## yt_video_analytics (0 Data-API units; Analytics API has separate quota)

**Params:** `videoIds?: string[]` (<=200), `startDate?/endDate?` (YYYY-MM-DD; default last 28 days), `metrics?: string[]` (default `views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage`), `dimensions?: string[]`, `maxResults?: 1..200` (default 50).
**Returns:** `dateRange`, `metrics`, `dimensions`, `columnHeaders[]`, `rows[][]`, note about separate quota.

## yt_search_public (100 units)

**Params:** `query` (min 2), `max?: 1..50` (default 10), `order?: relevance|date|viewCount|rating`, `includeStats?: boolean` (+1).
**Returns:** `results[] { videoId, title, channelId, channelTitle, publishedAt, description(200), url, views|null }`, `costNotice`.
**Guards:** refuses past 90% (`quota_guard`). Public data only.

## yt_get_comments (1 unit)

**Params:** `videoId` (11-char), `max?: 1..100` (default 20), `order?: time|relevance` (default time).
**Returns:** `threads[] { threadId, topLevelCommentId, author, authorChannelId, text, likeCount, publishedAt, updatedAt, totalReplyCount, replies[] (max 5) }`, `untrustedContentWarning`, `replyHint`.
**Use `topLevelCommentId` (or a reply `commentId`) as `parentId` for yt_reply_comment.**

## yt_reply_comment (WRITE - 50 units + 1 read-back)

**Params:** `parentId`, `text`, `confirm?: boolean` (default false = dry-run).
**Dry-run returns:** `mode:"dry-run"`, exact `payload` (`comments.insert` snippet), cost, warning that replies are public immediately.
**Confirm returns:** `commentId`, `readBack` (stored text/author/date/likes/status), `readBackOk`.
**Never call with confirm=true without the user's explicit approval of the exact text.**

## yt_update_metadata (WRITE - 1 + 50 + 1 units)

**Params:** `videoId`, `title?` (<=100 chars, no `<`/`>`), `description?` (<=5000), `tags?` (joined <=500 chars), `categoryId?`, `privacyStatus?: private|unlisted|public`, `confirm?`.
**Validation happens before any spend** (lengths, characters, tag budget; `public` refused unless `project.audited === true`).
**Dry-run returns:** full fetched `before` (current) and `diff` field-by-field, cost of the write, no changes made.
**Confirm returns:** `diff`, `readBack` (fields as stored on YouTube NOW), `readBackOk`.
Merge semantics: only provided fields change (the rest are carried over from current values).

## yt_set_thumbnail (WRITE - 50 units)

**Params:** `videoId`, `imagePath` (absolute), `confirm?`.
**Preflight (even for dry-run):** file exists, extension in {jpg, jpeg, png, gif, bmp}, size <= 2 MB.
**Dry-run returns:** image facts + `willCall` + cost.
**Confirm returns:** `thumbnails` URLs from the API response (`readBack` note: CDN propagation can lag minutes).

## yt_export_captions (50 units list / 200 units download)

**Params:** `videoId`, `captionId?` (absent = list mode), `format?: srt|sbv|ttml` (default srt), `outputDir?` (default `~/.ytagent/exports`).
**List returns:** `tracks[] { captionId, name, language, trackKind, isCC, isDraft, lastUpdated, status }` + hint to download.
**Download returns:** `savedPath`, `bytes`, `preview` (first 240 chars), `readBack` note (file re-read from disk).
**Policy:** own-videos only (API-enforced + agent contract). Captions of other creators are refused.

## yt_upload_video (WRITE - 1600 units + 1 read-back [+ 50 thumbnail])

**Params:** `filePath` (absolute; whitelisted formats incl. mp4/mov/mkv/webm; <=256 GB), `title` (<=100, no `<`/`>`), `description?` (<=5000), `tags?` (<=500 joined), `privacyStatus?` (default **private**), `categoryId?` (default 22), `madeForKids?` (default false), `publishAt?` (ISO-8601; forces private until then), `thumbnailPath?` (optional, +50), `confirm?`.
**Guards:** `public` refused unless audited; `quota_guard` past 90%.
**Dry-run returns:** full payload, file facts, schedule note, cost.
**Confirm performs:** resumable `videos.insert` (progress logged to stderr only) -> read-back of `status/processingDetails` -> **reports `actualPrivacy` (FACT)** -> if requested public/unlisted came back `private`, records `project.json.audited=false` and warns. Optional thumbnail set after.
**Returns:** `videoId`, `url`, `requestedPrivacy`, `actualPrivacy`, `privacyLocked`, `uploadStatus`, `processingStatus`, `readBackOk`, `thumbnail`, `costBreakdown`, `warnings[]`.
