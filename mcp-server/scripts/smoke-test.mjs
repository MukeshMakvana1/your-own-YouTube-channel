#!/usr/bin/env node
/**
 * ytagent MCP smoke test - spawns the built server and performs the real
 * MCP handshake over stdio:
 *   1. initialize
 *   2. tools/list  -> must contain all 11 yt_* tools
 *   3. tools/call yt_quota_status -> must return ok:true JSON (0 units,
 *      works even before OAuth setup - reports auth state instead).
 *
 * Usage: node scripts/smoke-test.mjs   (from the mcp-server folder, after `npm run build`)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "index.js");

const EXPECTED = [
  "yt_channel_stats",
  "yt_export_captions",
  "yt_get_comments",
  "yt_list_videos",
  "yt_quota_status",
  "yt_reply_comment",
  "yt_search_public",
  "yt_set_thumbnail",
  "yt_update_metadata",
  "yt_upload_video",
  "yt_video_analytics",
];

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: path.join(here, ".."),
});

let buffer = "";
let stderr = "";
const pending = new Map();
let done = false;

function finish(code, message) {
  if (done) return;
  done = true;
  clearTimeout(watchdog);
  if (message) {
    (code === 0 ? console.log : console.error)(message);
  }
  child.kill();
  process.exit(code);
}

const watchdog = setTimeout(
  () => finish(1, "FAIL: timeout after 45s\n--- server stderr ---\n" + stderr),
  45000
);

// Diagnostics: fail fast instead of waiting for the watchdog.
child.on("error", (e) => finish(1, "FAIL: could not spawn server: " + e.message));
child.on("exit", (code) => {
  finish(
    1,
    `FAIL: server exited before the handshake completed (exit code ${code})\n--- server stderr ---\n${stderr}`
  );
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

function request(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

child.stderr.on("data", (d) => {
  stderr += d.toString();
});

child.stdout.on("data", (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ytagent-smoke", version: "1.0.0" },
  });
  if (init.error) throw new Error("initialize failed: " + JSON.stringify(init.error));
  const serverName = init.result?.serverInfo?.name ?? "?";
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await request(2, "tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const missing = EXPECTED.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    throw new Error(
      `missing tools: ${missing.join(", ")}\n  got (${names.length}): ${names.join(", ")}`
    );
  }

  const call = await request(3, "tools/call", {
    name: "yt_quota_status",
    arguments: {},
  });
  const text = call.result?.content?.[0]?.text ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (!parsed || parsed.ok !== true) {
    throw new Error("yt_quota_status did not return ok:true JSON:\n" + text);
  }

  const auth = parsed.data?.auth ?? {};
  const quota = parsed.data?.quota ?? {};
  finish(
    0,
    [
      "PASS",
      `server: ${serverName}`,
      `tools (${names.length}): ${names.join(", ")}`,
      `yt_quota_status -> authenticated=${auth.authenticated}, tokenPresent=${auth.tokenPresent}, remainingToday=${quota.remaining}`,
    ].join("\n")
  );
} catch (e) {
  finish(1, "FAIL: " + e.message + "\n--- server stderr ---\n" + stderr);
}
