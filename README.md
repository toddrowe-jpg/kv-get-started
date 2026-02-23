# BITX Capital Blog Writing Worker Application

## Project Overview
The BITX Capital blog writing worker application facilitates the creation and management of blog content for BITX Capital's online presence. This application allows users to draft, edit, and publish articles efficiently using Cloudflare Workers AI, KV, Queues, and R2.

## Setup Instructions
1. **Clone the repository:**
   ```bash
   git clone https://github.com/toddrowe-jpg/kv-get-started.git
   ```
2. **Change directory:**
   ```bash
   cd kv-get-started
   ```
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Configure bindings** in `wrangler.jsonc` (replace placeholder values):
   - `JOBS_KV` — KV namespace ID from the Cloudflare dashboard
   - `ASSETS_R2` — R2 bucket name from the Cloudflare dashboard
   - `JOBS_QUEUE` — Queue name from the Cloudflare dashboard

## Required Cloudflare Bindings

| Binding | Type | Purpose |
|---|---|---|
| `AI` | Workers AI | LLM and image generation |
| `USER_NOTIFICATION` | KV Namespace | User notifications |
| `JOBS_KV` | KV Namespace | Job state persistence |
| `ASSETS_R2` | R2 Bucket | Generated image storage |
| `JOBS_QUEUE` | Queue | Background job processing |

WordPress secrets (future use — do **not** commit; add via `wrangler secret put`):
- `WP_USERNAME` — WordPress application username
- `WP_APP_PASSWORD` — WordPress application password

### WhatsApp Cloud API Secrets

Set all of the following via `wrangler secret put <NAME>` (never commit to source):

| Secret | Description |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Token you create; entered in Meta App Dashboard when registering webhook |
| `WHATSAPP_APP_SECRET` | Meta App Secret (used to verify `X-Hub-Signature-256` on every POST) |
| `WHATSAPP_TOKEN` | Permanent or system-user access token for sending messages |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Business phone number ID from Meta dashboard |
| `ADMIN_WHATSAPP_NUMBERS` | Comma-separated E.164 numbers allowed to issue commands, e.g. `+12032755433` |

```bash
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put WHATSAPP_APP_SECRET
wrangler secret put WHATSAPP_TOKEN
wrangler secret put WHATSAPP_PHONE_NUMBER_ID
wrangler secret put ADMIN_WHATSAPP_NUMBERS
# When prompted, enter the value (e.g. for ADMIN_WHATSAPP_NUMBERS: +12032755433)
```

## Job Pipeline Usage

### 1. Start a job
```
GET /start?topic=<your topic>&site=https://www.bitxcapital.com&publish=0
```
Returns:
```json
{
  "jobId": "...",
  "statusUrl": "/status?id=...",
  "resultUrl": "/result?id=..."
}
```

### 2. Poll job status
```
GET /status?id=<jobId>
```
Returns `status` values: `queued` → `running` → `complete` (or `error`).

### 3. Retrieve full result
```
GET /result?id=<jobId>
```
Returns the complete job record including the generated article `content`, `assetUrl`, and WordPress metadata.

### 4. Access the generated image
```
GET /asset/<jobId>
```
Streams the generated PNG image from R2. The `assetUrl` field in the job result points here.

## Background Processing
When a job is enqueued via `/start`, the Queue consumer:
1. Calls `@cf/meta/llama-3.3-70b-instruct` to generate article content (~800 tokens).
2. Calls `@cf/meta/llama-3.3-70b-instruct` again to produce an image prompt.
3. Calls `@cf/black-forest-labs/flux-1-schnell` to generate a header image.
4. Stores the image in R2 under `jobs/<jobId>/image.png`.
5. Marks the job `complete` in KV with `assetUrl` and `content` populated.

## WordPress Integration (Planned)
WordPress posting is **not yet implemented**. The job record already includes a `wp.baseUrl` placeholder (`https://www.bitxcapital.com`). When implemented, it will require:
- `WP_USERNAME` secret
- `WP_APP_PASSWORD` secret (WordPress Application Password)

## WhatsApp Webhook

Route: `bitxcapital.com/whatsapp/*`

### Webhook verification (GET)
Meta calls this when you register/edit the webhook in the App Dashboard:
```
GET /whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=<challenge>
```
Returns the challenge as plain text with 200 if the token matches, otherwise 403.

### Inbound messages (POST)
Meta posts signed payloads here. Every request is validated with `X-Hub-Signature-256` (HMAC-SHA256 using `WHATSAPP_APP_SECRET`). Requests from senders not in `ADMIN_WHATSAPP_NUMBERS` are silently ACKed.

Rate limit: 20 messages per 60 seconds per sender.

### Available commands

Send any of these as a WhatsApp message from an admin number:

| Command | Description |
|---|---|
| `help` | List available commands |
| `brand show` | Display stored brand profile |
| `brand set name: <text>` | Set the brand name |
| `brand set colors: #RRGGBB,#RRGGBB,...` | Set brand hex colors |
| `plan generate 30: <seed topic>` | Generate a 30-day content plan (AI or stub) |
| `plan list` | Show first 7 entries of the current plan |
| `approve <jobId>` | Mark a job approved (persists to KV; does not publish) |
| `reject <jobId> [reason]` | Mark a job rejected with optional reason |

### KV schema

| Key | Value | Description |
|---|---|---|
| `brand:profile` | JSON `{name, colors, updatedAt}` | Brand profile |
| `plan:current` | JSON `{seed, createdAt, entries[]}` | 30-day content plan |
| `job:<jobId>` | JSON `JobRecord` | Job state (extended with `approval`, `approvedBy`, etc.) |
| `wa:rl:<sender>` | JSON `{count, windowStart}` | Per-sender rate limit window |

### Example curl payloads (local dev)

```bash
# Webhook verification
curl "http://localhost:8787/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=mytoken&hub.challenge=abc123"

# Inbound message (requires valid HMAC — use wrangler dev with real secrets for testing)
curl -X POST http://localhost:8787/whatsapp/webhook \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=<hmac>" \
  -d '{
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "from": "12032755433",
            "id": "msg1",
            "timestamp": "1700000000",
            "type": "text",
            "text": { "body": "help" }
          }]
        }
      }]
    }]
  }'
```

## Architecture
Built on Cloudflare Workers using:
- **Workers AI** — LLM and image generation
- **Cloudflare Queues** — Durable background processing
- **Workers KV** — Job state and result storage
- **R2** — Binary image asset storage

## Security Measures
- No secrets committed to source control (use `wrangler secret put`)
- Input validation on all endpoints
- CORS headers set to `*` for API access

## Deployment
```bash
npm run deploy
```

