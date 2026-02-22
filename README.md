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

