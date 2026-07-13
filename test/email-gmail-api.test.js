import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Gmail API refreshes OAuth and sends MIME email", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arcovia-gmail-test-"));
  const clientPath = join(dir, "client.json");
  const tokenPath = join(dir, "token.json");
  writeFileSync(clientPath, JSON.stringify({ installed: { client_id: "client-id", client_secret: "client-secret" } }));
  writeFileSync(tokenPath, JSON.stringify({ refresh_token: "refresh-token" }));

  process.env.EMAIL_PROVIDER = "gmail";
  process.env.GOOGLE_OAUTH_CLIENT_PATH = clientPath;
  process.env.GOOGLE_OAUTH_TOKEN_PATH = tokenPath;
  process.env.GMAIL_USER = "arcovia.africa@gmail.com";
  process.env.GMAIL_FROM_EMAIL = "Arcovia <arcovia.africa@gmail.com>";

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "gmail-message-id" }), { status: 200 });
  };

  try {
    const { emailDiagnostics, sendEmail } = await import(`../src/email.js?gmail-test=${Date.now()}`);
    const diagnostics = emailDiagnostics();
    assert.equal(diagnostics.gmailApiConfigured, true);
    assert.deepEqual(diagnostics.activeProviderPlan, ["gmail"]);
    const result = await sendEmail({ to: "customer@example.com", subject: "Arcovia update", text: "Your sourcing process is progressing." });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "gmail");
    assert.equal(result.id, "gmail-message-id");
    assert.equal(calls.length, 2);
    const gmailPayload = JSON.parse(calls[1].options.body);
    const mime = Buffer.from(gmailPayload.raw, "base64url").toString("utf8");
    assert.match(mime, /From: Arcovia <arcovia\.africa@gmail\.com>/);
    assert.match(mime, /To: customer@example\.com/);
    assert.match(mime, /Subject: Arcovia update/);
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
