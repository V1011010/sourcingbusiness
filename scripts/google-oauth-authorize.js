import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const clientPath = process.env.GOOGLE_OAUTH_CLIENT_PATH || resolve(homedir(), ".arcovia", "google-oauth-client.json");
const tokenPath = process.env.GOOGLE_OAUTH_TOKEN_PATH || resolve(homedir(), ".arcovia", "google-oauth-token.json");
const scope = "https://www.googleapis.com/auth/gmail.send";

if (!existsSync(clientPath)) {
  console.error(`Google OAuth client file is missing: ${clientPath}`);
  process.exit(1);
}

const credentials = JSON.parse(readFileSync(clientPath, "utf8"));
const client = credentials.installed || credentials.web || {};
if (!client.client_id || !client.client_secret) {
  console.error("Google OAuth client file does not contain a client ID and secret.");
  process.exit(1);
}

const state = randomBytes(24).toString("hex");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth2/callback") return reply(res, 404, "Not found");
    if (url.searchParams.get("state") !== state) return reply(res, 400, "Invalid OAuth state. Close this page and retry.");
    const error = url.searchParams.get("error");
    if (error) return reply(res, 400, `Google authorization was not completed: ${error}`);
    const code = url.searchParams.get("code");
    if (!code) return reply(res, 400, "Google did not return an authorization code.");

    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2/callback`;
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });
    const detail = await response.text();
    if (!response.ok) throw new Error(`Google token exchange failed (${response.status}): ${detail}`);
    const token = JSON.parse(detail);
    if (!token.refresh_token) throw new Error("Google did not return a refresh token. Remove Arcovia Email Worker from Google Account access and retry.");
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, JSON.stringify({
      refresh_token: token.refresh_token,
      scope: token.scope || scope,
      token_type: token.token_type || "Bearer",
      created_at: new Date().toISOString()
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    reply(res, 200, "Arcovia Gmail authorization is complete. You may close this page.");
    console.log(`GOOGLE_OAUTH_AUTHORIZED token_path=${tokenPath}`);
    setTimeout(() => server.close(() => process.exit(0)), 500);
  } catch (error) {
    reply(res, 500, "Arcovia could not finish Gmail authorization. Return to the setup window for details.");
    console.error(error.message);
    setTimeout(() => server.close(() => process.exit(1)), 500);
  }
});

server.listen(0, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2/callback`;
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state
  });
  console.log(`GOOGLE_OAUTH_URL=${authorizationUrl.toString()}`);
  console.log("Waiting for Google authorization...");
});

function reply(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}
