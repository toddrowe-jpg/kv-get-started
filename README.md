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

#### `GET /workflow/:id`
Retrieves the full persisted state of a workflow execution (including all phase outputs, trace logs, and errors) by its ID.

```bash
curl "https://<worker-url>/workflow/wf_1720000000000_abc12345"
```

**Response:** the `WorkflowEntry` JSON object (same shape as the `state` field above).

Returns `404` if the ID is not found.

### Querying historical runs

The workflow ID is returned by `POST /workflow/blog`. Store it and use `GET /workflow/:id` to inspect the execution at any later time. Because state is stored in KV, it survives worker restarts and is accessible across all requests.


- JWT authentication for secure user sessions
- Input validation to prevent XSS and SQL injection attacks
- Rate limiting to prevent abuse of the API
- `GEMINI_API_KEY` is stored as a Cloudflare secret and never logged or returned in responses

## Deployment Guidelines
To deploy the application:
1. **Set required secrets:**
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   ```
2. **Deploy:**
   ```bash
   npm run deploy
   ```

