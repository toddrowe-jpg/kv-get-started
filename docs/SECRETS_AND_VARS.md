# Cloudflare Secrets & Variables — Management Guide

This document lists all required Cloudflare Worker **Secrets** and **Variables** for this project and explains how to manage them safely so they are never accidentally wiped during a deploy.

---

## Why secrets can appear to be "wiped" after a deploy

Cloudflare distinguishes between two storage mechanisms:

| Type | Managed via | Persists across `wrangler deploy`? |
|---|---|---|
| **Secret** | Cloudflare dashboard → *Settings → Variables → Secret variables*, or `wrangler secret put` | ✅ Yes — secrets are stored independently of the Worker bundle |
| **Variable (plain-text)** | `wrangler.jsonc` `vars` block, or Cloudflare dashboard → *Settings → Variables → Environment variables* | ⚠️ `vars` in `wrangler.jsonc` **overwrite** the dashboard value on every `wrangler deploy` |

**Key rule:** Never put a real secret value inside `wrangler.jsonc`. The `vars` block in this file is intentionally left with empty strings (`""`) as placeholders purely to help `wrangler cf-typegen` produce correct TypeScript types.  
Any value set there will be pushed to Cloudflare on the next deploy and will **replace** whatever was previously stored as an environment variable for that name.

---

## Required Secrets

Secrets must be set via the Cloudflare dashboard or the Wrangler CLI. They are **write-only** (not readable after creation) and are **not overwritten by `wrangler deploy`** — they are preserved across deployments.

### Checklist

- [ ] `GEMINI_API_KEY` — Google Gemini API key (obtain from [Google AI Studio](https://aistudio.google.com/app/apikey))
- [ ] `API_KEY` — Bearer token for general endpoint authentication
- [ ] `ADMIN_API_KEY` — Bearer token for `/admin/*` endpoints (Zero Trust)
- [ ] `WP_APP_PASSWORD` — WordPress Application Password for `/wp/publish`
- [ ] `WHATSAPP_APP_SECRET` — WhatsApp App Secret for webhook HMAC validation
- [ ] `WHATSAPP_ACCESS_TOKEN` — WhatsApp Cloud API access token

### How to set a secret (CLI)

```bash
npx wrangler secret put GEMINI_API_KEY
# Wrangler will prompt you to enter the value interactively — it is never echoed to the terminal
```

Repeat for each secret in the checklist above.

### How to set a secret (Dashboard)

1. Cloudflare Dashboard → **Workers & Pages** → select your Worker
2. **Settings** → **Variables** → **Secret variables**
3. Click **Add variable**, enter the name and value, then click **Encrypt & deploy**

---

## Optional Variables

These can be stored as plain-text environment variables (not secrets). They **can** be set in the Cloudflare dashboard, but they can also be defaulted in `wrangler.jsonc` `vars` without security risk because they do not contain credentials.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model identifier. Must match the `PHASE_MODEL_REGISTRY` in `src/agentRegistry.ts`. |
| `CF_ACCESS_AUD` | *(none)* | Cloudflare Access audience tag for Zero Trust JWT enforcement |
| `ALERT_WEBHOOK_URL` | *(none)* | Webhook URL for external alert delivery |
| `WP_SITE_URL` | *(none)* | WordPress site base URL (e.g. `https://example.kinsta.cloud`) |
| `WP_USER` | *(none)* | WordPress username |
| `WHATSAPP_VERIFY_TOKEN` | *(none)* | Token used to verify the WhatsApp webhook subscription |
| `WHATSAPP_PHONE_NUMBER_ID` | *(none)* | WhatsApp Cloud API phone number ID |
| `WHATSAPP_ADMIN_NUMBER` | *(none)* | WhatsApp number that receives admin alerts |

> **Recommendation:** Treat `WP_USER` and `WP_SITE_URL` as non-sensitive and set them in the dashboard as plain variables. Keep `WP_APP_PASSWORD` as a **secret**.

---

## Safe deploy checklist

Before running `wrangler deploy` (or merging a PR that triggers a deploy), verify:

- [ ] `wrangler.jsonc` `vars` block contains **only empty strings** (`""`) for secret-valued fields — never real keys or passwords.
- [ ] `.dev.vars` is listed in `.gitignore` (it already is) and is **not** staged for commit.
- [ ] After deploy, spot-check one secret in the Cloudflare dashboard (it should still show as **Encrypted**).
- [ ] Test a live endpoint that depends on `GEMINI_API_KEY` to confirm it is still present (e.g. `GET /gemini/research?q=smoke+test`).

---

## Recovering from accidentally cleared secrets

If a deploy or dashboard action caused a secret to be cleared:

1. Obtain the correct value from a secure credential store (password manager, team vault, etc.).
2. Re-set it:
   ```bash
   npx wrangler secret put <VAR_NAME>
   ```
3. Wrangler does **not** require a redeploy after `secret put` — the new value is available immediately.
4. Re-test the affected endpoint.

---

## Keeping secrets out of the repository

The following safeguards are already in place:

- `.dev.vars` is listed in `.gitignore` — this file is the standard Wrangler local-dev secrets file and must never be committed.
- `wrangler.jsonc` `vars` values are intentionally left as empty strings.
- `OutputSanitizer` in `src/sanitizer.ts` automatically redacts sensitive-looking fields from all JSON responses.

**Do not** add a pre-commit hook that simply bans the word "secret" — it will produce too many false positives. Instead, rely on the empty-placeholder pattern in `wrangler.jsonc` and the `.gitignore` rule for `.dev.vars`.

---

## Model registry alignment

When changing `GEMINI_MODEL` in Cloudflare, also update `PHASE_MODEL_REGISTRY` in `src/agentRegistry.ts` (or update `GEMINI_DEFAULT_MODEL` in `src/gemini.ts`) and redeploy. A mismatch between the runtime `GEMINI_MODEL` value and the registry causes a `500 PhaseModelMismatchError` on all `/gemini/*` endpoints.

Current model assignment: **`gemini-2.5-flash`** for all Gemini-backed phases (`research`, `outline`, `draft`, `edit`, `factcheck`).
