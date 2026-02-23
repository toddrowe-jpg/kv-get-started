# BITX Capital Blog Writing Worker Application

## Project Overview
The BITX Capital blog writing worker application facilitates the creation and management of blog content for BITX Capital's online presence. This application allows users to draft, edit, and publish articles efficiently.

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

## Secrets & Environment Variables

### `GEMINI_API_KEY`
Required for the `/gemini/*` endpoints. Obtain an API key from [Google AI Studio](https://aistudio.google.com/app/apikey) and add it as a Cloudflare secret:

```bash
npx wrangler secret put GEMINI_API_KEY
```

You will be prompted to enter the key value. The secret is stored securely in Cloudflare and is never logged or exposed in responses.

## Architecture
The application is built using a microservices architecture that allows independent scaling and development of different components. It leverages Node.js for the server-side logic and MongoDB for data storage.

## Features
- User authentication
- Rich text editor for drafting articles
- Version control for articles
- Publishing onto the BITX Capital blog

## API Endpoints

### Workers AI Endpoints
| Endpoint | Method | Description |
|---|---|---|
| `/research?q=<query>` | GET | LLM research via `@cf/meta/llama-3.3-70b-instruct` |
| `/summarize?text=<text>` | GET | Text summarization via `@cf/facebook/bart-large-cnn` |
| `/embed?text=<text>` | GET | Text embeddings via `@cf/baai/bge-large-en-v1.5` |
| `/image?q=<prompt>` | GET | Image generation via `@cf/black-forest-labs/flux-1-schnell` |

### Google Gemini Endpoints
These endpoints require `GEMINI_API_KEY` to be set.

#### `GET /gemini/research?q=<topic>`
Returns structured JSON suitable for outlining a blog post.

```bash
curl "https://<worker-url>/gemini/research?q=decentralized+finance+trends"
```

**Response:**
```json
{
  "topic": "Decentralized Finance Trends",
  "summary": "...",
  "keyPoints": ["...", "..."],
  "suggestedHeadings": ["Introduction", "..."],
  "sources": ["..."]
}
```

#### `POST /gemini/edit`
Accepts a blog draft and returns a Markdown-improved version optimized for EEAT, clarity, structure, and CTA.

```bash
curl -X POST "https://<worker-url>/gemini/edit" \
  -H "Content-Type: application/json" \
  -d '{"draft": "Your blog draft text here..."}'
```

**Response:**
```json
{ "revised": "# Revised Blog Post\n\n..." }
```

#### `POST /gemini/factcheck`
Accepts a blog draft and optional source references, then returns a JSON report flagging unsupported claims with suggested rewrites.

```bash
curl -X POST "https://<worker-url>/gemini/factcheck" \
  -H "Content-Type: application/json" \
  -d '{
    "draft": "Your blog draft text here...",
    "sources": [
      { "url": "https://example.com/article", "title": "Article Title", "text": "Relevant excerpt..." }
    ]
  }'
```

**Response:**
```json
{
  "findings": [
    {
      "claim": "Bitcoin was invented in 2009.",
      "supported": true,
      "sourceRef": "Article Title",
      "suggestedRewrite": ""
    }
  ]
}
```

## Role Separation Enforcement

The Worker enforces **programmatic role separation** for every AI-backed workflow phase via `src/agentRegistry.ts`. Each phase is assigned exactly one designated model/agent in the `PHASE_MODEL_REGISTRY`. Before any AI call is made, `assertPhaseModel(phase, model)` is called to verify that the correct model is being used. If the wrong model is supplied, a `PhaseModelMismatchError` is thrown and the request returns a `500` response.

### Phase–Model Registry

| Phase | Designated Model/Agent | Description |
|---|---|---|
| `research` | `gemini-1.5-flash-latest` | Blog topic research via Google Gemini |
| `outline` | `gemini-1.5-flash-latest` | Blog outline generation via Google Gemini |
| `draft` | `gemini-1.5-flash-latest` | Full blog draft writing via Google Gemini |
| `edit` | `gemini-1.5-flash-latest` | Blog draft editing via Google Gemini |
| `factcheck` | `gemini-1.5-flash-latest` | Fact-checking against sources via Google Gemini |
| `image` | `@cf/black-forest-labs/flux-1-schnell` | Image generation via Cloudflare Workers AI |
| `summarize` | `@cf/facebook/bart-large-cnn` | Text summarization via Cloudflare Workers AI |

The registry (`PHASE_MODEL_REGISTRY`) is exposed in the root endpoint response so clients can inspect the current assignments at runtime.

To change a phase's model, update only `src/agentRegistry.ts`—all enforcement throughout the Worker is derived from that single source of truth.

## Python Prompt Pipelines

The prompt-building pipelines originally defined in `path/to/blog_writing_worker_direction.py` are ported to TypeScript in `src/pythonPipelines.ts` and exposed as REST endpoints so they can be triggered directly from the Worker:

| Python function | TypeScript function | REST endpoint |
|---|---|---|
| `outline_prompt(brief)` | `buildOutlinePrompt(brief)` | `POST /workflow/blog/outline` |
| `draft_prompt(brief, outline)` | `buildDraftPrompt(brief, outline)` | `POST /workflow/blog/draft` |
| `system_prompt(style_guide, brand_kit)` | `buildSystemPrompt(styleGuide, brandKit)` | *(used internally)* |

Each pipeline endpoint validates the `BlogBrief` input fields, enforces role separation via the agent registry, persists state to KV, and returns the full `WorkflowEntry` alongside the `workflowId`.

## Workflow Persistence (KV)

Blog workflow executions are persisted in Cloudflare KV under the binding `BLOG_WORKFLOW_STATE`. Each run is stored as a JSON entry keyed by its workflow ID (`workflow:<id>`) and includes:

| Field | Description |
|---|---|
| `id` | Unique workflow identifier |
| `status` | `running`, `completed`, or `failed` |
| `currentPhase` | Name of the most-recently active phase |
| `phaseOutputs` | Map of phase name → output data |
| `errors` | Array of `{ phase, message, timestamp }` error objects |
| `traceLogs` | Array of `{ timestamp, phase, event, details }` log entries |
| `createdAt` / `updatedAt` | ISO-8601 timestamps |

### Setup: Create the KV namespace

Before deploying, create the namespace in your Cloudflare account and update `wrangler.jsonc` with the real ID:

```bash
npx wrangler kv namespace create BLOG_WORKFLOW_STATE
```

Replace the placeholder `id` in `wrangler.jsonc` with the ID printed by the command above.

### Workflow API Endpoints

#### `POST /workflow/blog`
Starts a new blog workflow execution. The research phase is run via Gemini and all outputs, logs, and errors are persisted to KV.

```bash
curl -X POST "https://<worker-url>/workflow/blog" \
  -H "Content-Type: application/json" \
  -d '{"topic": "SBA 7(a) Loans for small businesses"}'
```

**Response:**
```json
{
  "workflowId": "wf_1720000000000_abc12345",
  "state": {
    "id": "wf_1720000000000_abc12345",
    "status": "completed",
    "currentPhase": "research",
    "phaseOutputs": {
      "research": {
        "topic": "SBA 7(a) Loans for small businesses",
        "summary": "...",
        "keyPoints": ["..."],
        "suggestedHeadings": ["..."],
        "sources": ["..."]
      }
    },
    "errors": [],
    "traceLogs": [
      { "timestamp": "...", "phase": "research", "event": "phase_started", "details": { "topic": "SBA 7(a) Loans..." } },
      { "timestamp": "...", "phase": "research", "event": "phase_completed" }
    ],
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

If the Gemini call fails the `status` will be `"failed"` and `errors` will contain the error detail.

#### `POST /workflow/blog/outline`
Runs the **outline pipeline** (ported from the Python prompt builder). Accepts a blog brief and returns a detailed outline including title options, meta description, H2/H3 structure, and a suggested CTA.

```bash
curl -X POST "https://<worker-url>/workflow/blog/outline" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "SBA 7(a) Loans for small businesses",
    "audience": "small business owners",
    "primary_keyword": "SBA 7(a) loans",
    "goal": "educate and convert",
    "angle": "practical guide",
    "word_count": 1200,
    "sources": ["SBA.gov", "Forbes Small Business"]
  }'
```

**Required fields:** `topic`  
**Optional fields (have defaults):** `audience`, `primary_keyword`, `goal`, `angle`, `word_count`, `sources`

**Response:**
```json
{
  "workflowId": "wf_...",
  "state": {
    "status": "completed",
    "currentPhase": "outline",
    "phaseOutputs": {
      "outline": { "outline": "## Title Options\n1. ..." }
    }
  }
}
```

#### `POST /workflow/blog/draft`
Runs the **draft pipeline** (ported from the Python prompt builder). Accepts a blog brief plus a previously generated outline and returns the full Markdown blog post.

```bash
curl -X POST "https://<worker-url>/workflow/blog/draft" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "SBA 7(a) Loans for small businesses",
    "audience": "small business owners",
    "primary_keyword": "SBA 7(a) loans",
    "goal": "educate and convert",
    "angle": "practical guide",
    "word_count": 1200,
    "sources": [],
    "outline": "## Introduction\n## What is an SBA 7(a) Loan?\n..."
  }'
```

**Required fields:** `topic`, `outline`  
**Optional fields (have defaults):** `audience`, `primary_keyword`, `goal`, `angle`, `word_count`, `sources`

**Response:**
```json
{
  "workflowId": "wf_...",
  "state": {
    "status": "completed",
    "currentPhase": "draft",
    "phaseOutputs": {
      "draft": { "draft": "# SBA 7(a) Loans...\n\n..." }
    }
  }
}
```


#### `GET /workflow/:id`
Retrieves the full persisted state of a workflow execution (including all phase outputs, trace logs, and errors) by its ID.

```bash
curl "https://<worker-url>/workflow/wf_1720000000000_abc12345"
```

**Response:** the `WorkflowEntry` JSON object (same shape as the `state` field above).

Returns `404` if the ID is not found.

### Querying historical runs

The workflow ID is returned by `POST /workflow/blog`. Store it and use `GET /workflow/:id` to inspect the execution at any later time. Because state is stored in KV, it survives worker restarts and is accessible across all requests.


## Security

All protected endpoints enforce the following middleware pipeline on every request:

### 1. Bearer Token Authentication
Set the `API_KEY` secret to enable authentication. When set, every request must include a valid `Authorization: Bearer <key>` header or it will receive a `401 Unauthorized` response.

```bash
npx wrangler secret put API_KEY
```

If `API_KEY` is not configured the Worker operates in **open mode** (all requests are allowed), which is useful during local development.

### 2. Rate Limiting
A sliding-window rate limiter is enforced per client IP (via the `CF-Connecting-IP` header). Requests exceeding **60 per minute** receive a `429 Too Many Requests` response. The limiter tracks per-IP timestamps within a 60-second sliding window; timestamps older than the window are evicted on each check.

### 3. Input Size Limiting
Requests whose `Content-Length` header exceeds **1 MB** are rejected with a `413`-class error before the body is read. Individual endpoint fields also have their own size limits (e.g. `draft` ≤ 20 000 characters, query params ≤ 500 characters).

### 4. Output Sanitization
All JSON responses pass through `OutputSanitizer`, which automatically redacts any field whose name matches a known-sensitive pattern (`api_key`, `password`, `secret`, `credential`, `private_key`, `authorization`). This prevents accidental leakage of secrets in AI-generated content.

### 5. Security Response Headers
Every response includes the following hardened HTTP headers:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-XSS-Protection` | `1; mode=block` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Content-Security-Policy` | `default-src 'self'` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

### 6. CORS
`OPTIONS` preflight requests are handled automatically and return the appropriate `Access-Control-Allow-*` headers.

## Deployment Guidelines
To deploy the application:
1. **Set required secrets:**
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   ```
2. **(Optional) Set the alert webhook URL:**
   ```bash
   npx wrangler secret put ALERT_WEBHOOK_URL
   ```
3. **Deploy:**
   ```bash
   npm run deploy
   ```

## Observability & Alerting

The Worker ships structured logs, abuse records, and alerts to the **`BLOG_WORKFLOW_STATE` Cloudflare KV namespace** using a dedicated key-space prefix (`obs:*`). All writes are non-blocking — observability errors are swallowed and logged to the Worker console so they can never interrupt request handling.

### KV Key Structure

| Key pattern | Content | TTL |
|---|---|---|
| `obs:log:<YYYY-MM-DD>:<uuid>` | Structured request/event log entry | 7 days |
| `obs:abuse:<ip>` | Per-IP abuse counters (auth failures, rate-limit hits) | 24 hours |
| `obs:alert:<uuid>` | Generated alert record | 30 days |

### What is logged

Every request handled by the Worker writes an `ObsEvent` entry of type `request` (level `INFO`). Additional event types written automatically:

| Event type | Level | Trigger |
|---|---|---|
| `request` | INFO | Every incoming request (authenticated or not) |
| `auth_failure` | WARN | Bearer token rejected by the middleware chain |
| `rate_limited` | WARN | Request blocked by the sliding-window rate limiter |
| `quota_exceeded` | ERROR | Daily token quota would be exceeded |
| `error` | ERROR | Unhandled exception or Gemini API error |
| `phase_transition` | INFO | Workflow phase started / completed (via `WorkflowStore.addLog`) |

### Abuse detection

The Worker tracks per-IP abuse counters:

- **Auth failures**: incremented on every `401` response due to a bad/missing Bearer token.
- **Rate-limit hits**: incremented on every `429` response due to the rate limiter.

When an IP reaches the threshold (`authFailures ≥ 10` or `rateLimitHits ≥ 5`), its abuse record is flagged (`flagged: true`) and an `abuse_detected` alert is created automatically.

### Alerts

Alerts are generated for the following conditions:

| Alert type | Severity | Trigger |
|---|---|---|
| `workflow_failed` | critical | A workflow phase (`research`, `outline`, or `draft`) throws an error |
| `workflow_stuck` | warning | A workflow is still in `running` state > 5 minutes after its last update |
| `quota_exceeded` | warning | Daily LLM token quota exceeded |
| `api_error` | warning / critical | Gemini API error or unhandled exception in a request |
| `abuse_detected` | critical | An IP reaches the auth-failure or rate-limit abuse threshold |

### External webhook notifications

Set the `ALERT_WEBHOOK_URL` secret to receive alert payloads via HTTP POST whenever an alert is created:

```bash
npx wrangler secret put ALERT_WEBHOOK_URL
# paste your webhook URL (e.g. Slack incoming webhook, PagerDuty Events API, etc.)
```

The POST body is JSON with the shape:

```json
{
  "type": "workflow_failed",
  "severity": "critical",
  "message": "Workflow wf_... failed at phase \"research\": ...",
  "details": { "workflowId": "...", "phase": "research", "error": "..." },
  "timestamp": "2025-01-01T00:00:00.000Z",
  "alertId": "<uuid>"
}
```

Webhook delivery failures are logged to the Worker console but do not affect the HTTP response returned to the client.

### Stuck workflow detection

When a client calls `GET /workflow/:id`, the Worker checks whether the workflow is still in `running` status and has not been updated for more than **5 minutes**. If so, a `workflow_stuck` alert is created and — if `ALERT_WEBHOOK_URL` is configured — the notification is sent immediately.

### Admin API endpoints

All admin endpoints require the same Bearer token authentication as other endpoints.

#### `GET /admin/logs?date=<YYYY-MM-DD>`
Returns all observability log events stored for the given date (defaults to today, UTC).

```bash
curl "https://<worker-url>/admin/logs" \
  -H "Authorization: Bearer <API_KEY>"
```

**Response:**
```json
{ "logs": [ { "id": "...", "type": "request", "level": "INFO", ... } ] }
```

#### `GET /admin/alerts`
Returns all stored alerts, newest first.

```bash
curl "https://<worker-url>/admin/alerts" \
  -H "Authorization: Bearer <API_KEY>"
```

**Response:**
```json
{ "alerts": [ { "id": "...", "type": "workflow_failed", "severity": "critical", ... } ] }
```

#### `GET /admin/abuse?ip=<ip-address>`
Returns the abuse record for a specific IP address, or `null` if no abuse has been recorded.

```bash
curl "https://<worker-url>/admin/abuse?ip=1.2.3.4" \
  -H "Authorization: Bearer <API_KEY>"
```

**Response:**
```json
{
  "record": {
    "ip": "1.2.3.4",
    "authFailures": 3,
    "rateLimitHits": 0,
    "firstSeen": "...",
    "lastSeen": "...",
    "flagged": false
  }
}
```


