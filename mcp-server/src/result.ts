import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Uniform JSON result helpers.
 * stdout is reserved for the MCP protocol - every tool result is a single
 * JSON document inside `content`, never a multiline panic dump.
 */

export function ok(
  tool: string,
  data: unknown,
  summary?: string
): CallToolResult {
  const payload = { ok: true, tool, summary: summary ?? null, data };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(
  tool: string,
  code: string,
  message: string,
  hint?: string,
  extra?: Record<string, unknown>
): CallToolResult {
  const payload = {
    ok: false,
    tool,
    error: { code, message, hint: hint ?? null, ...(extra ?? {}) },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/** Normalize a googleapis/Gaxios error into a clean, actionable shape. */
export function apiError(tool: string, e: unknown): CallToolResult {
  const anyErr = e as {
    response?: { status?: number; data?: { error?: any } };
    code?: string | number;
    message?: string;
  };
  const resp = anyErr?.response;
  const gerr = resp?.data?.error; // Google APIs error envelope
  const httpStatus = resp?.status ?? null;
  const reason: string | null =
    gerr?.errors?.[0]?.reason ?? gerr?.status ?? null;
  const message: string = gerr?.message ?? anyErr?.message ?? String(e);
  const code = String(gerr?.code ?? httpStatus ?? anyErr?.code ?? "unknown");

  let hint: string | undefined;
  if (reason === "quotaExceeded" || message.includes("quota")) {
    hint =
      "Daily API quota exhausted (resets at midnight Pacific). Wait for the reset, or raise YTAGENT_DAILY_QUOTA only if your Google project limit is genuinely higher.";
  } else if (message.toLowerCase().includes("not been audited")) {
    hint =
      "Your Google Cloud project has not passed the YouTube audit. Uploads will stay locked private. Request an audit via YouTube API Services - Audit and Quota Extension form.";
  } else if (reason === "insufficientPermissions" || httpStatus === 403) {
    hint =
      "Token may be missing a scope. Delete token.json in the data dir and re-run `npm run setup-auth`.";
  } else if (httpStatus === 401) {
    hint =
      "Token invalid or revoked. Re-run `npm run setup-auth` and restart OpenCode.";
  }

  return fail(
    tool,
    `api_error_${code}`,
    message,
    hint,
    { reason, httpStatus }
  );
}
