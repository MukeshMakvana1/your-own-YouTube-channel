/**
 * One-time OAuth 2.0 setup for ytagent.
 *
 * Usage (after `npm run build`):
 *   npm run setup-auth
 *
 * Requires: a Google Cloud OAuth client of type "Desktop app", with the
 * YouTube Data API v3 and YouTube Analytics API enabled, saved as
 * <data dir>\client_secret.json (default data dir: %USERPROFILE%\.ytagent).
 *
 * Opens a browser to the Google consent screen, listens on a loopback port
 * for the redirect, exchanges the code, saves token.json, and verifies the
 * authorized channel identity.
 */
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { SCOPES, readClientSecret } from "../auth.js";
import { clientSecretPath, dataDir, tokenPath } from "../paths.js";

const PORT = Number.parseInt(process.env.YTAGENT_OAUTH_PORT ?? "42813", 10);
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;

function openBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* URL is printed above; user can open it manually */
  }
}

async function main(): Promise<void> {
  const creds = readClientSecret();
  if (!creds) {
    console.error(
      `[ytagent] Missing OAuth client secret JSON at:\n  ${clientSecretPath()}\n`
    );
    console.error(
      "Create a Google Cloud OAuth client (type: Desktop app) with YouTube Data API v3\n" +
        "and YouTube Analytics API enabled, download the JSON, and save it to that path.\n" +
        "Or set YTAGENT_CLIENT_SECRETS_FILE to the JSON's location."
    );
    process.exit(1);
  }

  const oauth = new OAuth2Client({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri: REDIRECT,
  });

  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
      if (u.pathname !== "/oauth2callback") {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      const err = u.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(`OAuth error: ${err}`);
        console.error(`[ytagent] OAuth error: ${err}`);
        server.close();
        process.exit(1);
      }
      const code = u.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing code");
        return;
      }

      const { tokens } = await oauth.getToken(code);
      oauth.setCredentials(tokens);
      fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2));

      // Verify identity: which channel did we just authorize? (1 quota unit)
      let identity = "could not verify";
      try {
        const yt = google.youtube({ version: "v3", auth: oauth });
        const who = await yt.channels.list({
          part: ["snippet", "statistics"],
          mine: true,
        });
        const ch = who.data.items?.[0];
        if (ch) {
          identity = `${ch.snippet?.title} (${ch.id}) - subscribers: ${
            ch.statistics?.subscriberCount ?? "hidden"
          }`;
        } else {
          identity = "Google account has no YouTube channel";
        }
      } catch (e) {
        identity = `verification failed: ${(e as Error).message}`;
      }

      res
        .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        .end("ytagent authorized. You can close this tab and return to the terminal.");
      console.log(`\n[ytagent] Authorized. Token saved to: ${tokenPath()}`);
      console.log(`[ytagent] Channel: ${identity}`);
      console.log("[ytagent] Next: restart OpenCode so the MCP server picks up the token.");
      server.close();
      process.exit(0);
    } catch (e) {
      console.error(`[ytagent] Token exchange failed: ${(e as Error).message}`);
      try {
        res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed - see terminal.");
      } catch {
        /* response already sent */
      }
      server.close();
      process.exit(1);
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[ytagent] Data directory: ${dataDir()}`);
    console.log(`[ytagent] Open this URL to authorize ytagent:\n\n${authUrl}\n`);
    console.log(`[ytagent] Waiting for consent on ${REDIRECT} ...`);
    openBrowser(authUrl);
  });
}

main().catch((e) => {
  console.error(`[ytagent] setup-auth failed: ${(e as Error).message}`);
  process.exit(1);
});
