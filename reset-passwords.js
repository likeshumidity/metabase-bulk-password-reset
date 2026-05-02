#!/usr/bin/env node
// Bulk-trigger password reset emails for all Metabase users.
//
// No third-party dependencies. Requires Node.js 18+ (uses built-in fetch).
//
// Lists users via GET /api/user (admin API key required), then triggers
// Metabase's standard "Forgot password?" email flow per user via
// POST /api/session/forgot_password. Users receive the same reset email
// they'd get from clicking "Forgot password?" on the login screen.

const fs = require("node:fs");

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.url || !args.key) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const baseUrl = String(args.url).replace(/\/+$/, "");
const apiKey = String(args.key);
const rps = Math.max(1, Number(args.rps) || 5);
const dryRun = !!args["dry-run"];
const includeDeactivated = !!args["include-deactivated"];
const includeSso = !!args["include-sso"];
const emailsFile = args.emails ? String(args.emails) : null;

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

async function main() {
  console.log(`Listing users from ${baseUrl} ...`);
  const allFetched = await listAllUsers(includeDeactivated);
  const scopeLabel = includeDeactivated ? "including deactivated" : "active only";
  console.log(`Found ${allFetched.length} user(s) in Metabase (${scopeLabel}).`);

  // If --emails is provided, restrict to matching emails (case-insensitive).
  let candidates = allFetched;
  if (emailsFile) {
    const inputEmails = readEmailsFile(emailsFile);
    console.log(`\nFound ${inputEmails.length} email(s) in ${emailsFile}.`);
    console.log("Validating emails against Metabase users:");
    const byEmail = new Map(allFetched.map((u) => [u.email.toLowerCase(), u]));
    const matched = [];
    for (const email of inputEmails) {
      const u = byEmail.get(email.toLowerCase());
      if (u) {
        console.log(`  ${email}  found`);
        matched.push(u);
      } else {
        console.log(`  ${email}  NOT FOUND`);
      }
    }
    candidates = matched;
    console.log(`\n${matched.length} of ${inputEmails.length} email(s) matched a Metabase user.`);
  }

  // SSO users (sso_source != null) don't have Metabase-managed passwords — Metabase's
  // reset email is useless to them and would only confuse anyone who reads it. Default
  // to excluding them; --include-sso to override.
  const ssoUsers = candidates.filter((u) => u.sso_source != null);
  const users = includeSso ? candidates : candidates.filter((u) => u.sso_source == null);

  if (ssoUsers.length > 0) {
    console.log(
      includeSso
        ? `  ${ssoUsers.length} SSO user(s) included (--include-sso). Note: their reset emails will be inert.`
        : `  Skipping ${ssoUsers.length} SSO user(s). Use --include-sso to include them.`,
    );
  }
  console.log(`Eligible for reset: ${users.length}.`);

  if (users.length === 0) return;

  if (dryRun) {
    console.log("\n[DRY RUN] Would trigger reset emails for:");
    users.forEach((u, i) =>
      console.log(
        `  ${i + 1}. ${u.email}  (id=${u.id}, ${(u.first_name ?? "").trim()} ${(u.last_name ?? "").trim()}${
          u.sso_source ? `, sso=${u.sso_source}` : ""
        })`,
      ),
    );
    return;
  }

  console.log(`\nTriggering reset emails at ${rps} req/sec ...\n`);
  const results = await rateLimitedAll(users, triggerReset, rps);

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  console.log(`\nDone. Success: ${ok}. Failed: ${failed}.`);
  if (failed > 0) {
    console.log("\nFailures:");
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.email}: ${r.error}`));
    process.exit(2);
  }
}

async function listAllUsers(includeDeactivated) {
  const all = [];
  const limit = 500;
  let offset = 0;
  const statusParam = includeDeactivated ? "&status=all" : "";
  while (true) {
    const resp = await mbFetch(`/api/user?limit=${limit}&offset=${offset}${statusParam}`);
    const page = Array.isArray(resp) ? resp : resp.data;
    if (!Array.isArray(page)) {
      throw new Error(`Unexpected /api/user response shape: ${JSON.stringify(resp).slice(0, 200)}`);
    }
    all.push(...page);
    if (page.length < limit) break;
    offset += page.length;
  }
  return all.filter((u) => u.email);
}

async function triggerReset(user) {
  try {
    const r = await fetch(`${baseUrl}/api/session/forgot_password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.log(`  x ${user.email} -- HTTP ${r.status} ${text.slice(0, 120)}`);
      return { ok: false, email: user.email, error: `HTTP ${r.status} ${text.slice(0, 200)}` };
    }
    console.log(`  ok ${user.email}`);
    return { ok: true, email: user.email };
  } catch (err) {
    console.log(`  x ${user.email} -- ${err.message}`);
    return { ok: false, email: user.email, error: err.message };
  }
}

async function mbFetch(path) {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`GET ${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

// Kick off `fn(item)` per item, pacing starts at most `rps` per second.
// Requests run concurrently (overlap is fine); only the start times are paced.
async function rateLimitedAll(items, fn, rps) {
  const interval = 1000 / rps;
  const promises = [];
  let lastStart = 0;
  for (const item of items) {
    const wait = Math.max(0, lastStart + interval - Date.now());
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    promises.push(fn(item));
  }
  return Promise.all(promises);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a text file containing one email per line.
// - Trims whitespace.
// - Skips blank lines and lines starting with `#` (comments).
// - Dedupes case-insensitively, preserving the first-seen casing for output.
function readEmailsFile(path) {
  const text = fs.readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const lower = line.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(line);
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function printHelp() {
  console.log(`
Bulk-trigger Metabase password reset emails for all users.

Usage:
  node reset-passwords.js --url <metabase-url> --key <admin-api-key> [options]

Required:
  --url <url>             Base Metabase URL (e.g. https://metabase.example.com)
  --key <key>             Admin API key (see README for setup)

Options:
  --dry-run               List users that would be reset; send no emails
  --rps <n>               Max requests per second (default: 5)
  --emails <file>         Path to a text file of emails (one per line, blank
                          lines and #-comments ignored). Only users whose
                          email matches an entry in the file will be reset.
                          Each input email is validated against /api/user
                          and reported as 'found' or 'NOT FOUND'.
  --include-deactivated   Also reset deactivated users (default: skip)
  --include-sso           Also reset SSO users (default: skip). Only useful
                          if your instance has password login enabled
                          alongside SSO (MB_ENABLE_PASSWORD_LOGIN=true or
                          Admin > Settings > Authentication > Enable
                          Password Login). Otherwise SSO users have no
                          Metabase-managed password to reset.
  --help, -h              Show this help

Examples:
  # Preview all active users (no emails sent):
  node reset-passwords.js --url https://metabase.example.com --key mb_xxx --dry-run

  # Actually send reset emails to all active users:
  node reset-passwords.js --url https://metabase.example.com --key mb_xxx

  # Reset only specific users from a list:
  node reset-passwords.js --url https://metabase.example.com --key mb_xxx \\
    --emails ./users-to-reset.txt --dry-run
`);
}
