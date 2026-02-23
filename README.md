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

### `GEMINI_MODEL` (optional)
Override the Gemini model used by all `/gemini/*` endpoints. Defaults to `gemini-1.5-flash-latest`. Set as a Cloudflare environment variable in `wrangler.jsonc` or via the Cloudflare dashboard — no code redeploy required.

Commonly supported model IDs for the `v1beta` `generateContent` API:
- `gemini-1.5-flash-latest` (default)
- `gemini-1.5-pro-latest`
- `gemini-2.0-flash`

```jsonc
// wrangler.jsonc
{
  "vars": {
    "GEMINI_MODEL": "gemini-1.5-pro-latest"
  }
}
```

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

## Security Measures
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

