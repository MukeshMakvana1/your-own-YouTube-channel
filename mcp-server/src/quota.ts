import fs from "node:fs";
import { quotaPath } from "./paths.js";

/**
 * Local quota ledger for the YouTube Data API v3 (10,000 units/day default).
 * The real quota lives server-side in Google's project; this ledger is an
 * ESTIMATE that stops this server from blowing the daily budget.
 *
 * Google resets quota at midnight Pacific Time, so "today" is computed in
 * America/Los_Angeles, not local time.
 */

export const COSTS = {
  channels_list: 1,
  playlist_items_list: 1,
  videos_list: 1,
  comment_threads_list: 1,
  comments_list: 1,
  comments_insert: 50,
  videos_update: 50,
  thumbnails_set: 50,
  captions_list: 50,
  captions_download: 200,
  search_list: 100,
  videos_insert: 1600,
} as const;

export interface QuotaState {
  period: string; // YYYY-MM-DD in America/Los_Angeles
  limit: number;
  spent: number;
  calls: number;
  byTool: Record<string, number>;
  updatedAt: string;
}

function todayInPT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
}

export function limit(): number {
  const n = Number.parseInt(process.env.YTAGENT_DAILY_QUOTA ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

export function load(): QuotaState {
  const fresh: QuotaState = {
    period: todayInPT(),
    limit: limit(),
    spent: 0,
    calls: 0,
    byTool: {},
    updatedAt: new Date().toISOString(),
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(quotaPath(), "utf8")) as QuotaState;
    if (parsed.period !== fresh.period) return fresh; // new quota day
    return { ...fresh, ...parsed, limit: limit() };
  } catch {
    return fresh;
  }
}

function save(state: QuotaState): void {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(quotaPath(), JSON.stringify(state, null, 2));
}

export interface QuotaCheck {
  allowed: boolean;
  cost: number;
  spent: number;
  remaining: number;
  limit: number;
  stopAt: number;
  reason: string | null;
}

/**
 * Pre-flight check for every spend. Blocks any call that would push usage
 * past 90% of the daily limit (hard rule: stop at 90%).
 */
export function check(cost: number): QuotaCheck {
  const s = load();
  const stopAt = Math.floor(s.limit * 0.9);
  const remaining = Math.max(0, s.limit - s.spent);
  const allowed = cost === 0 || s.spent + cost <= stopAt;
  return {
    allowed,
    cost,
    spent: s.spent,
    remaining,
    limit: s.limit,
    stopAt,
    reason: allowed
      ? null
      : `Call costs ${cost} units; spent=${s.spent}; the 90% stop threshold (${stopAt}) would be exceeded. Refusing to spend.`,
  };
}

/** Record actual spend after (or during) a real API call. */
export function record(tool: string, cost: number): void {
  if (cost <= 0) return;
  const s = load();
  s.spent += cost;
  s.calls += 1;
  s.byTool[tool] = (s.byTool[tool] ?? 0) + cost;
  save(s);
}

export function snapshot(): QuotaState & { stopAt: number; remaining: number } {
  const s = load();
  return {
    ...s,
    remaining: Math.max(0, s.limit - s.spent),
    stopAt: Math.floor(s.limit * 0.9),
  };
}

/** Compact quota block attached to every tool result. */
export function block(usedThisCall: number): Record<string, unknown> {
  const s = load();
  return {
    usedThisCall,
    spentToday: s.spent,
    callsToday: s.calls,
    remainingToday: Math.max(0, s.limit - s.spent),
    limit: s.limit,
    stopAt: Math.floor(s.limit * 0.9),
    note: "Local ESTIMATE - other clients sharing the same Google Cloud project are not counted.",
  };
}
