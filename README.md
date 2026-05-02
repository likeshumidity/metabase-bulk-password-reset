# metabase-bulk-password-reset

Trigger Metabase's standard password-reset email for every user in your instance, in one command.

Useful when you need to force a password rotation across all users (e.g. after a security event, or when migrating from another auth system to Metabase-managed passwords).

## What it does

1. Lists every user in your Metabase via `GET /api/user` (using an admin API key).
2. For each user, calls `POST /api/session/forgot_password` with their email — exactly what happens when a user clicks **"Forgot password?"** on the login screen.
3. Each user receives Metabase's standard reset email with a one-time link. They set their own new password.

> **Note:** Reset emails come from Metabase's configured email server. If your instance's email is not configured (Admin → Settings → Email), reset emails won't be delivered. Confirm email is working before running this against many users.

By default, the script processes only **active, password-authenticated users**. Two categories are skipped automatically:

- **Deactivated users** — typically pointless to reset. Override with `--include-deactivated`.
- **SSO users** (Google, SAML, JWT, LDAP) — they don't have a Metabase-managed password, so the reset email is inert and only confuses recipients (who may waste time trying to "reset their SSO password"). Override with `--include-sso` only if you have a specific reason. The script identifies SSO users by the `sso_source` field on `/api/user`; if it's non-null, they're skipped.

## Requirements

- **Node.js 18 or newer.** Uses the built-in `fetch` API; no `npm install` step.
  - Check your version: `node --version`
  - If you have an older Node, install a current LTS from <https://nodejs.org/> or via your package manager.
- **An admin API key** for your Metabase instance (see below).

There are no other dependencies — no `package.json`, no `npm install`. Just a single `.js` file and Node.

## Getting an admin API key

API keys are created by an admin in your Metabase instance:

1. Sign in as an admin.
2. Go to **Admin settings → Authentication → API keys**.
3. Click **Create API key**.
4. Name it (e.g. `password-reset`) and assign it to a group with admin permissions (the **Administrators** group, or a group with full data + settings access).
5. Copy the generated key — it starts with `mb_…`. **You can only see it once.**
6. Store it securely. Delete the key from Metabase when you're done.

Full docs: <https://www.metabase.com/docs/latest/people-and-groups/api-keys>

## Usage

> **⚠️ Always do a dry-run first.** Run with `--dry-run` to preview which users will be affected before sending any reset emails. Skip this step at your peril — there is no undo for sent emails.

### Step 1: Dry-run (no emails sent)

```bash
node reset-passwords.js \
  --url https://metabase.example.com \
  --key mb_your_admin_api_key_here \
  --dry-run
```

Verify the user list looks correct, then continue.

### Step 2: Live run (sends reset emails)

```bash
node reset-passwords.js \
  --url https://metabase.example.com \
  --key mb_your_admin_api_key_here
```

### Two ways to invoke

The script has a `#!/usr/bin/env node` shebang, so you can run it either of these ways — they're identical, pick whichever you prefer:

**Option A — invoke via `node` (no setup required):**

```bash
node reset-passwords.js --url ... --key ... --dry-run
```

**Option B — make it executable once, then run directly:**

```bash
chmod a+x reset-passwords.js
./reset-passwords.js --url ... --key ... --dry-run
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--url <url>` | Base URL of your Metabase instance | *(required)* |
| `--key <key>` | Admin API key | *(required)* |
| `--dry-run` | Preview only — list users without sending emails | off |
| `--rps <n>` | Max requests per second | `5` |
| `--include-deactivated` | Also reset deactivated users | off (skipped) |
| `--include-sso` | Also reset SSO users (rarely useful — see note above) | off (skipped) |
| `--help` | Print usage | — |

## Rate limiting

The script paces requests at **5 per second by default** (configurable with `--rps`). This keeps load on your Metabase server low and stays well below the per-IP throttle that Metabase applies to the forgot-password endpoint.

If you hit throttling errors (`HTTP 429`), lower `--rps` (e.g. `--rps 2`) and re-run for the failed users.

Requests are dispatched **concurrently but paced** — request *starts* are spaced apart, but multiple requests can be in flight at once. This is fast enough for thousands of users while remaining polite.

## Output

For each user, the script prints `ok user@example.com` or `x user@example.com -- <error>`. At the end, you get a summary like:

```
Done. Success: 247. Failed: 3.

Failures:
  - jane@example.com: HTTP 429 ...
  - bob@example.com: HTTP 500 ...
```

Exit codes:

- `0` — all resets succeeded
- `1` — fatal error (couldn't list users, bad arguments, etc.)
- `2` — completed, but some individual resets failed

## Security notes

- **Treat the API key like a password.** Anyone with it has full admin access to your Metabase.
- **Delete the key when done.** Admin → Authentication → API keys → revoke.
- The script never writes the key to disk; it's only read from `--key` at runtime.
- Consider running this from a controlled machine (e.g. an admin's laptop or a one-off CI job), not a shared environment.

## Troubleshooting

**`HTTP 401` listing users**
The API key is invalid, expired, or missing admin permissions. Re-check the key and the group it's assigned to.

**`HTTP 429` from `forgot_password`**
You're hitting Metabase's per-IP throttle on the forgot-password endpoint. Lower `--rps` and re-run — successful users will get the email twice (harmless), and failed ones will succeed on the second pass.

**No reset emails arriving**
Test email delivery in **Admin → Settings → Email → Send test email**. Reset emails use the same SMTP config; if test email fails, password resets won't deliver either.

**Users with SSO can't reset**
That's why the script skips them by default. SSO users authenticate via your identity provider and don't have a Metabase-managed password — reset them in your IdP instead. If you somehow want to send them an inert reset email anyway (rarely useful), pass `--include-sso`.

## License / sharing

Customers are welcome to copy, modify, and re-run this script. It's intentionally a single dependency-free file so you can audit it end-to-end before running it against your production Metabase.
