import assert from "node:assert/strict";
import test from "node:test";

process.env.EMAIL_PROVIDER = "ses";
process.env.AWS_SES_REGION = "eu-west-1";
process.env.AWS_SES_DOMAIN = "arcovia.africa";
process.env.AWS_ACCESS_KEY_ID = "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
process.env.FROM_EMAIL = "Arcovia <updates@arcovia.africa>";
process.env.SMTP_USER = "";
process.env.SMTP_PASSWORD = "";

const { emailDiagnostics } = await import("../src/email.js");

test("Amazon SES HTTPS API is selected without SMTP credentials", () => {
  const diagnostics = emailDiagnostics();
  assert.equal(diagnostics.ready, true);
  assert.equal(diagnostics.sesApiConfigured, true);
  assert.equal(diagnostics.smtpConfigured, false);
  assert.deepEqual(diagnostics.activeProviderPlan, ["ses"]);
  assert.equal(diagnostics.senderDomain, "arcovia.africa");
  assert.equal(diagnostics.issues.includes("missing_smtp_user"), false);
  assert.equal(diagnostics.issues.includes("missing_smtp_password"), false);
});
