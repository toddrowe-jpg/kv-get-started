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

All API and model credentials **must** be stored as Cloudflare Worker secrets and sourced from the runtime environment. No API keys or tokens are ever hardcoded in the application code. The following secrets are supported:

| Secret name | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes (for `/gemini/*`) | Google Gemini API key |
| `API_KEY` | Recommended | Bearer token for general endpoint authentication |
| `ADMIN_API_KEY` | Recommended | Separate Bearer token for `/admin/*` endpoints (Zero Trust) |
| `CF_ACCESS_AUD` | Optional | Cloudflare Access audience tag for Zero Trust JWT enforcement |
| `ALERT_WEBHOOK_URL` | Optional | Webhook URL for external alert delivery |
| `WP_SITE_URL` | Yes (for `/wp/publish`) | WordPress site base URL, e.g. `https://example.kinsta.cloud` |
| `WP_USER` | Yes (for `/wp/publish`) | WordPress username that owns the Application Password |
| `WP_APP_PASSWORD` | Yes (for `/wp/publish`) | WordPress Application Password (spaces are stripped automatically) |

### `GEMINI_API_KEY`
Required for the `/gemini/*` endpoints. Obtain an API key from [Google AI Studio](https://aistudio.google.com/app/apikey) and add it as a Cloudflare secret:

```bash
npx wrangler secret put GEMINI_API_KEY
```

You will be prompted to enter the key value. The secret is stored securely in Cloudflare and is never logged or exposed in responses.

### `API_KEY`
Enables Bearer token authentication for all endpoints. Without this secret the Worker operates in **open mode** (all requests are allowed), which is suitable only for local development.

```bash
npx wrangler secret put API_KEY
```

### `ADMIN_API_KEY`
A separate, privileged Bearer token required for all `/admin/*` endpoints. When set, admin routes **reject** requests that present the regular `API_KEY` — the caller must supply `ADMIN_API_KEY` instead. This provides explicit access separation between general API consumers and admin operators.

```bash
npx wrangler secret put ADMIN_API_KEY
```

### `CF_ACCESS_AUD`
Optional Cloudflare Zero Trust audience tag. When set, admin and workflow-trigger endpoints additionally verify the `Cf-Access-Jwt-Assertion` header, confirming the request was validated by a Cloudflare Access policy before reaching the Worker. See [Zero Trust setup](#zero-trust-cloudflare-access-configuration) below.

```bash
npx wrangler secret put CF_ACCESS_AUD
```

### `WP_SITE_URL`
Base URL of the WordPress site (no trailing slash) targeted by the `/wp/publish` endpoint.

```bash
npx wrangler secret put WP_SITE_URL
# e.g. https://bitxcapital.kinsta.cloud
```

### `WP_USER`
WordPress username that owns the Application Password used for REST API authentication.

```bash
npx wrangler secret put WP_USER
# e.g. bitx-worker
```

### `WP_APP_PASSWORD`
WordPress [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) for the user above. Application Passwords are displayed with spaces for readability; the Worker strips spaces automatically before encoding the credential.

```bash
npx wrangler secret put WP_APP_PASSWORD
# paste the Application Password (spaces are fine)
```

## Architecture
The application is built using a microservices architecture that allows independent scaling and development of different components. It leverages Node.js for the server-side logic and MongoDB for data storage.

## Features
- User authentication
- Rich text editor for drafting articles
- Version control for articles
- Publishing onto the BITX Capital blog

## API Endpoints

### WordPress Publishing Endpoint

#### `POST /wp/publish`
Creates a post (draft or published) on the configured WordPress site via the REST API. Requires `WP_SITE_URL`, `WP_USER`, and `WP_APP_PASSWORD` secrets.

The Worker composes the final HTML body before sending it to WordPress:
1. Prepends an `<h1>` using `title` if the content lacks one.
2. Appends an **Apply Now** CTA button (unless `includeApplyNowButton` is `false`).
3. Appends a **Related Links** section when `relatedLinks` is provided.
4. Appends an **FAQ** section when `faq` is provided (semantic HTML fallback — see note below).

**Minimal example:**
```bash
curl -X POST "https://<worker-url>/wp/publish" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{
    "title": "My New Post",
    "contentHtml": "<p>This is the post body in HTML.</p>",
    "status": "draft",
    "categories": ["Finance", "Crypto"],
    "tags": ["bitcoin", "defi"]
  }'
```

**Full example (all optional fields):**
```bash
curl -X POST "https://<worker-url>/wp/publish" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{
    "title": "Personal Loans Guide",
    "contentHtml": "<p>Everything you need to know about personal loans.</p>",
    "status": "publish",
    "categories": ["Finance"],
    "tags": ["loans", "personal finance"],
    "yoast": {
      "title": "Personal Loans Guide – BitX Capital",
      "description": "Learn about personal loan options, rates, and how to apply with BitX Capital.",
      "focuskw": "personal loans"
    },
    "relatedLinks": [
      { "title": "Home Loans", "url": "https://bitxcapital.com/home-loans/" },
      { "title": "Business Loans", "url": "https://bitxcapital.com/business-loans/" }
    ],
    "faq": [
      {
        "question": "What is the minimum credit score required?",
        "answerText": "We consider applicants with a variety of credit profiles."
      },
      {
        "question": "How quickly can I get funds?",
        "answerHtml": "<p>Funds are typically disbursed within <strong>24–48 hours</strong> of approval.</p>"
      }
    ],
    "includeApplyNowButton": true
  }'
```

**Required fields:** `title`, `contentHtml`  
**Optional fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `status` | `"draft" \| "publish" \| "pending" \| "private"` | `"draft"` | WordPress post status |
| `categories` | `string[]` | `[]` | Category names (created if not found) |
| `tags` | `string[]` | `[]` | Tag names (created if not found) |
| `yoast.title` | `string` | — | Yoast SEO title (`_yoast_wpseo_title`) — max 300 chars |
| `yoast.description` | `string` | — | Yoast meta description (`_yoast_wpseo_metadesc`) — max 320 chars |
| `yoast.focuskw` | `string` | — | Yoast focus keyphrase (`_yoast_wpseo_focuskw`) — max 200 chars |
| `relatedLinks` | `Array<{title, url}>` | — | Related links appended at the bottom (max 20) |
| `faq` | `Array<{question, answerHtml?, answerText?}>` | — | FAQ items appended at the bottom (max 30) |
| `includeApplyNowButton` | `boolean` | `true` | Append an "Apply Now" button to `https://bitxcapital.com/application-journey/` |

> **Note on Yoast FAQ structured schema:** Yoast's rich-results FAQ schema requires the Gutenberg block editor and the Yoast SEO FAQ block. The Worker renders FAQ content as semantic HTML (`<section class="faq">`), which serves as a visual fallback. To enable Yoast FAQ rich results, replace the HTML in the WP editor with Gutenberg-serialised FAQ blocks after importing the post.

**Response (201 Created):**
```json
{
  "postId": 42,
  "wpLink": "https://bitxcapital.kinsta.cloud/?p=42",
  "status": "draft",
  "categoryIds": [3, 7],
  "tagIds": [12]
}
```

Category and tag names that do not yet exist in WordPress are created automatically. Existing terms are resolved by name (case-insensitive) or slug.

**Error responses:**
- `400 Bad Request` — missing or invalid fields (e.g. `title`, `contentHtml`, bad `status` value, invalid URL in `relatedLinks`, array limit exceeded)
- `503 Service Unavailable` — `WP_SITE_URL`, `WP_USER`, or `WP_APP_PASSWORD` not configured
- `4xx/502` — WordPress returned an error (propagated with `wpStatus` and `error` fields)

### Orchestration (End-to-End Workflow)
| Endpoint | Method | Description |
|---|---|---|
| `/workflow/execute` | POST | Run the **full workflow** (research → outline → draft) in a single call |
| `/workflow/:id` | GET | Retrieve persisted workflow state, phase outputs, trace logs, and errors |

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
| `compliance` | `rule-based` | Compliance, SEO, grammar, and forbidden-phrase validation (deterministic rules, no AI model) |

The registry (`PHASE_MODEL_REGISTRY`) is exposed in the root endpoint response so clients can inspect the current assignments at runtime.

To change a phase's model, update only `src/agentRegistry.ts`—all enforcement throughout the Worker is derived from that single source of truth.

## Python Prompt Pipelines

The prompt-building pipelines originally defined in `path/to/blog_writing_worker_direction.py` are ported to TypeScript in `src/pythonPipelines.ts` and exposed as REST endpoints so they can be triggered directly from the Worker:

| Python function | TypeScript function | REST endpoint |
|---|---|---|
| `outline_prompt(brief)` | `buildOutlinePrompt(brief)` | `POST /workflow/blog/outline` |
| `draft_prompt(brief, outline)` | `buildDraftPrompt(brief, outline)` | `POST /workflow/blog/draft` |
| `system_prompt(style_guide, brand_kit)` | `buildSystemPrompt(styleGuide, brandKit)` | *(used internally)* |
| `validate_no_dashes(md)` | `validateNoDashes(md)` | *(invoked in compliance phase)* |
| *(suite of validators)* | `runComplianceChecks(md, primaryKeyword?)` | *(invoked in compliance phase)* |

Each pipeline endpoint validates the `BlogBrief` input fields, enforces role separation via the agent registry, persists state to KV, and returns the full `WorkflowEntry` alongside the `workflowId`.

### Compliance Validators

`runComplianceChecks(md, primaryKeyword?)` collects all violations without throwing, so every issue is surfaced at once. It runs the following rules (ported from the Python validator suite):

| Rule ID | Description |
|---|---|
| `no_forbidden_dashes` | No em-dash (—) or en-dash (–) characters allowed |
| `keyword_present` | Primary SEO keyword must appear in the content (case-insensitive) |
| `non_empty_content` | Draft must not be empty |

Each violation is a `ComplianceViolation` object `{ rule: string; message: string }`. All violations are stored in `phaseOutputs.compliance.violations` and individually logged as `violation_found` trace events in the KV workflow record.

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

#### `POST /workflow/execute`
Runs the **full end-to-end blog workflow** in a single call, automatically chaining the research → outline → draft phases. State is persisted in KV after every phase, so the full execution record (including phase outputs, trace logs, and any errors) is available via `GET /workflow/:id` after the call completes.

```bash
curl -X POST "https://<worker-url>/workflow/execute" \
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
  "workflowId": "wf_1720000000000_abc12345",
  "state": {
    "id": "wf_1720000000000_abc12345",
    "status": "completed",
    "currentPhase": "compliance",
    "phaseOutputs": {
      "research": { "topic": "...", "summary": "...", "keyPoints": ["..."], "suggestedHeadings": ["..."], "sources": ["..."] },
      "outline": { "outline": "## Title Options\n1. ..." },
      "draft": { "draft": "# SBA 7(a) Loans...\n\n..." },
      "compliance": { "violations": [] }
    },
    "errors": [],
    "traceLogs": [
      { "timestamp": "...", "phase": "research", "event": "phase_started", "details": { "topic": "SBA 7(a) Loans..." } },
      { "timestamp": "...", "phase": "research", "event": "phase_completed" },
      { "timestamp": "...", "phase": "outline", "event": "phase_started", "details": { "topic": "SBA 7(a) Loans..." } },
      { "timestamp": "...", "phase": "outline", "event": "phase_completed" },
      { "timestamp": "...", "phase": "draft", "event": "phase_started", "details": { "topic": "SBA 7(a) Loans..." } },
      { "timestamp": "...", "phase": "draft", "event": "phase_completed" },
      { "timestamp": "...", "phase": "compliance", "event": "phase_started", "details": { "topic": "SBA 7(a) Loans..." } },
      { "timestamp": "...", "phase": "compliance", "event": "phase_completed", "details": { "violationCount": 0 } }
    ],
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

If any phase fails, the workflow `status` is set to `"failed"`, subsequent phases are skipped, and `errors` contains the error detail. The `workflowId` is always returned so you can inspect the partial state later.

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

### Querying historical runs and accessing artifacts

The workflow ID is returned by every `POST /workflow/*` endpoint. Store it and use `GET /workflow/:id` to inspect the execution at any later time. Because state is stored in KV, it survives worker restarts and is accessible across all requests.

#### Accessing phase outputs (artifacts)

Each phase output is stored under the `phaseOutputs` map in the `WorkflowEntry`. After a successful `POST /workflow/execute` call you can retrieve the generated draft like this:

```bash
# 1. Run the workflow and capture the workflow ID
RESPONSE=$(curl -s -X POST "https://<worker-url>/workflow/execute" \
  -H "Content-Type: application/json" \
  -d '{"topic": "SBA 7(a) Loans for small businesses"}')
WF_ID=$(echo "$RESPONSE" | jq -r '.workflowId')

# 2. Retrieve the full state (includes all phase outputs)
curl "https://<worker-url>/workflow/$WF_ID" | jq .

# 3. Extract just the draft artifact
curl "https://<worker-url>/workflow/$WF_ID" | jq '.phaseOutputs.draft.draft'
```

#### Accessing trace logs for debugging

Every `phase_started`, `phase_completed`, and `phase_failed` event is recorded in `traceLogs`:

```bash
curl "https://<worker-url>/workflow/$WF_ID" | jq '.traceLogs'
```

Observability logs (request events, quota errors, etc.) are stored separately and accessible via the admin API:

```bash
# All logs for today
curl "https://<worker-url>/admin/logs" -H "Authorization: Bearer <API_KEY>"

# Logs for a specific date
curl "https://<worker-url>/admin/logs?date=2025-01-15" -H "Authorization: Bearer <API_KEY>"
```


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

### 7. Admin / Zero Trust Access Guard
All `/admin/*` endpoints are protected by an additional access guard applied **after** the general middleware pipeline:

- **`ADMIN_API_KEY`** — if configured, the request's `Authorization: Bearer` token must equal `ADMIN_API_KEY`. Requests that carry the regular `API_KEY` are rejected with `403 Forbidden`. This separates general API access from privileged admin operations.
- **`CF_ACCESS_AUD`** — if configured, the request must also carry a `Cf-Access-Jwt-Assertion` header, which Cloudflare Access injects automatically for requests validated by a Zero Trust policy. Requests without this header are rejected with `403 Forbidden`.

The two guards are applied together: a request must satisfy **all configured guards** to reach an admin endpoint.

### Middleware Pipeline Summary

```
Every request
  └─ CORS preflight check (OPTIONS → short-circuit 200)
  └─ Middleware chain:
       1. Bearer token auth     (401 if invalid when API_KEY is set)
       2. Rate limiter          (429 if > 60 req/min per IP)
       3. Input size check      (reject if Content-Length > 1 MB)
  └─ /admin/* routes:
       4. Admin key guard       (403 if ADMIN_API_KEY is set and token doesn't match)
       5. CF Access JWT guard   (403 if CF_ACCESS_AUD is set and header is absent)
  └─ Route handler
  └─ Output sanitization + security response headers applied to all responses
```

## Zero Trust — Cloudflare Access Configuration

To protect admin and operator endpoints using [Cloudflare Zero Trust](https://www.cloudflare.com/zero-trust/):

1. **Create an Access Application** in the Cloudflare Zero Trust dashboard:
   - Type: **Self-hosted**
   - Application domain: `<your-worker-domain>/admin/*`  
   - Session duration: set to your policy requirement
   - Note the **Application Audience (AUD) tag** shown in the application settings

2. **Configure an Access Policy** (e.g. allow only users in your organisation's IdP, or an allowlist of email addresses).

3. **Store the AUD tag as a Worker secret:**
   ```bash
   npx wrangler secret put CF_ACCESS_AUD
   # paste the Application Audience tag value
   ```

4. **Store a separate admin Bearer token:**
   ```bash
   npx wrangler secret put ADMIN_API_KEY
   # use a strong random value, different from API_KEY
   ```

5. **Deploy the Worker** — admin endpoints now require both a valid Cloudflare Access JWT (via the `Cf-Access-Jwt-Assertion` header injected by Cloudflare's network) and the `ADMIN_API_KEY` Bearer token.

> **Note:** Cloudflare Access validates the JWT signature and identity claims before forwarding the request to the Worker. The Worker's `checkCfAccessJwt` guard confirms the assertion header is present, providing defense-in-depth against requests that bypass Cloudflare's network.

## Deployment Guidelines
To deploy the application:
1. **Set required secrets:**
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put API_KEY
   npx wrangler secret put ADMIN_API_KEY
   ```
2. **(Optional) Set WordPress publishing secrets:**
   ```bash
   npx wrangler secret put WP_SITE_URL
   npx wrangler secret put WP_USER
   npx wrangler secret put WP_APP_PASSWORD
   ```
3. **(Optional) Set the alert webhook URL:**
   ```bash
   npx wrangler secret put ALERT_WEBHOOK_URL
   ```
4. **(Optional) Configure Zero Trust for admin endpoints:**
   ```bash
   npx wrangler secret put CF_ACCESS_AUD
   ```
5. **Deploy:**
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
| `workflow_failed` | critical | A workflow phase (`research`, `outline`, or `draft`) throws an error in any workflow endpoint |
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

All admin endpoints require Bearer token authentication. By default they accept the general `API_KEY`. When `ADMIN_API_KEY` is set, admin routes require that dedicated token instead of the general key. If `CF_ACCESS_AUD` is also set, requests must additionally carry a valid `Cf-Access-Jwt-Assertion` header (Cloudflare Zero Trust).

#### How operators are notified

Operators can receive real-time alerts through two channels:

1. **Webhook notifications** (push): Set `ALERT_WEBHOOK_URL` to receive an HTTP POST payload whenever a critical event occurs (workflow failure, quota exceeded, abuse detected, Gemini API error, stuck workflow). Compatible with Slack incoming webhooks, PagerDuty Events API, or any custom HTTP receiver.
2. **Polling via admin endpoints** (pull): Use `GET /admin/alerts` to query all stored alerts at any time, or `GET /admin/status` to get a live dashboard view of all workflow runs.

See the [External webhook notifications](#external-webhook-notifications) section above for the webhook payload shape.

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

#### `GET /admin/status`
Returns an aggregated dashboard view of all blog/content workflow runs — including counts by status, a list of stuck and failed workflows (with their errors), and the 20 most recent runs.

```bash
curl "https://<worker-url>/admin/status" \
  -H "Authorization: Bearer <API_KEY>"
```

**Response:**
```json
{
  "generatedAt": "2025-01-01T00:00:00.000Z",
  "stats": {
    "total": 42,
    "running": 1,
    "completed": 38,
    "failed": 2,
    "stuck": 1
  },
  "stuckWorkflows": [
    {
      "id": "wf_1720000000000_abc12345",
      "status": "running",
      "currentPhase": "outline",
      "errors": [],
      "traceLogs": [...],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "failedWorkflows": [
    {
      "id": "wf_1719999990000_def67890",
      "status": "failed",
      "currentPhase": "research",
      "errors": [{ "phase": "research", "message": "Gemini API quota exceeded", "timestamp": "..." }],
      "traceLogs": [...],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "recentWorkflows": [ ... ]
}
```

A workflow is classified as **stuck** when it has been in `running` status for more than 5 minutes without an `updatedAt` refresh.


