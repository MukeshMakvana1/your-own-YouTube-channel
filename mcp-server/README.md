# ytagent MCP server

TypeScript MCP server (stdio) that wraps **YouTube Data API v3** + **YouTube Analytics API v2** as 11 typed tools for ONE owned channel. Built with `@modelcontextprotocol/sdk`, `googleapis`, `zod`.

## Tools (11)

| Tool | Cost (units) | Kind | Notes |
|---|---|---|---|
| `yt_quota_status` | 0 | read | Session grounding: local quota ledger, OAuth state, project audit flag, channel cache |
| `yt_channel_stats` | 1 | read | Channel ID, stats, uploads playlist; refreshes local cache |
| `yt_list_videos` | 1 / 50 videos | read | Uploads playlist paging (+1/50 for stats) |
| `yt_video_analytics` | 0 Data-API | read | Analytics API v2 (separate quota); supports per-video filters |
| `yt_search_public` | 100 | read | Public search only |
| `yt_get_comments` | 1 | read | Threads + `topLevelCommentId` for replies |
| `yt_reply_comment` | 50 + 1 | **write** | Dry-run unless `confirm=true`; read-back after write |
| `yt_update_metadata` | 1 + 50 + 1 | **write** | Before/after diff dry-run; read-back after write |
| `yt_set_thumbnail` | 50 | **write** | Preflight: JPG/PNG/GIF/BMP, <= 2 MB |
| `yt_export_captions` | 50 / 200 | read | Own videos only; list 50, download 200 |
| `yt_upload_video` | 1600 + 1 | **write** | Private by default; resumable; actual privacy read back |

Every write tool follows: **dry-run -> explicit `confirm=true` -> real call -> read-back of stored state**.
The server hard-refuses any spend past **90%** of the daily quota (local ledger, midnight-PT reset).

## Layout

```
src/
  index.ts            MCP bootstrap (stdio), registers all tools
  paths.ts            data dir resolution (~/.ytagent by default)
  auth.ts             OAuth2 client, token persistence, scopes
  youtube.ts          googleapis clients + channel cache helpers
  quota.ts            local quota ledger (COSTS table, check/record/block)
  project.ts          audit flag (env override or learned from uploads)
  result.ts           ok/fail/apiError JSON result helpers
  scripts/setup-auth.ts   one-time browser OAuth consent (loopback)
  tools/              one file per tool + index.ts registry
scripts/smoke-test.mjs   spawns dist/, MCP handshake, tools/list, one real call
```

## Commands

```powershell
npm.cmd install          # install deps (use npm.cmd if npm.ps1 is blocked)
npm.cmd run build        # tsc -> dist/
npm.cmd run setup-auth   # one-time OAuth: browser consent -> token.json
npm.cmd run smoke        # verify: handshake + 11 tools + real yt_quota_status call
```

## Environment (all optional, see .env.example)

- `YTAGENT_DATA_DIR` - state dir (default `%USERPROFILE%\.ytagent`)
- `YTAGENT_CLIENT_SECRETS_FILE` - OAuth client JSON path (default `<data dir>\client_secret.json`)
- `YTAGENT_DAILY_QUOTA` - daily unit budget (default 10000)
- `YTAGENT_PROJECT_AUDITED` - force audit flag true/false (default: learned)
- `YTAGENT_OAUTH_PORT` - loopback port for setup-auth (default 42813)

## Data directory (~/.ytagent)

```
client_secret.json   OAuth client (you place it; NEVER commit)
token.json           tokens (created by setup-auth; auto-refreshed)
quota.json           daily ledger
project.json         audit flag (learned from uploads)
channel.json         channel id + uploads playlist cache
exports\             caption downloads
```

## Security

- Secrets never leave the data dir; nothing secret is ever printed in tool output.
- stdout is MCP protocol only; all logging goes to stderr.
- Comment/title/description text returned by tools is untrusted user data - the agent contract requires treating it as data, never instructions.
- Caption download works only for videos you own (API-enforced).

## Register in OpenCode

```json
"ytagent": {
  "type": "local",
  "command": ["node", "C:/Users/KRUNAL/Desktop/youtube agent with mcp/mcp-server/dist/index.js"]
}
```

Restart OpenCode after registering; tools appear as `ytagent_yt_*`.
