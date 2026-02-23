import { GeminiApiError, geminiGenerate } from "./gemini";
import { WorkflowStore } from "./workflowStore";
import { QuotaStore, QuotaExceededError } from "./quotaStore";
import {
  setupMiddlewareChain,
  securityHeadersMiddleware,
  corsMiddleware,
  errorResponse,
  requestLoggingMiddleware,
  sanitizeOutput,
} from "./middleware";
import {
  assertPhaseModel,
  PhaseModelMismatchError,
  PHASE_MODEL_REGISTRY,
} from "./agentRegistry";
import { buildOutlinePrompt, buildDraftPrompt, BlogBrief } from "./pythonPipelines";

export interface Env {
  AI: {
    run(model: string, input: unknown): Promise<unknown>;
  };
  GEMINI_API_KEY: string;
  /** KV namespace for persisting blog workflow state, logs, and errors. */
  BLOG_WORKFLOW_STATE: KVNamespace;
  /** Optional Bearer token for API authentication. Set via: npx wrangler secret put API_KEY */
  API_KEY?: string;
}

/** Daily token limit used by the quota store (30 K tokens/day). */
const DAILY_TOKEN_LIMIT = 30_000;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(sanitizeOutput(data)), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight before any other processing
    const corsResponse = corsMiddleware(request);
    if (corsResponse) return corsResponse;

    const { pathname, searchParams } = new URL(request.url);

    // Apply security middleware chain to all protected endpoints
    const chain = setupMiddlewareChain(env.API_KEY);
    const { allowed, context } = await chain.execute(request);
    requestLoggingMiddleware(request, context);

    if (!allowed) {
      if (context.rateLimited) {
        return securityHeadersMiddleware(
          errorResponse(429, "Too Many Requests", context.requestId)
        );
      }
      return securityHeadersMiddleware(
        errorResponse(401, "Unauthorized: valid Bearer token required", context.requestId)
      );
    }

    try {
      // Quota store shared across all AI endpoints for this request
      const quota = new QuotaStore(env.BLOG_WORKFLOW_STATE, DAILY_TOKEN_LIMIT);

      if (pathname === "/research") {
        const q = searchParams.get("q");
        if (!q) return securityHeadersMiddleware(jsonResponse({ error: "Missing required query param: q" }, 400));
        await quota.consumeTokens(800, "research");
        const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
          prompt: q,
          max_tokens: 800,
        });
        return securityHeadersMiddleware(jsonResponse(result));
      }

      if (pathname === "/summarize") {
        const text = searchParams.get("text");
        if (!text) return securityHeadersMiddleware(jsonResponse({ error: "Missing required query param: text" }, 400));
        await quota.consumeTokens(200, "summarize");
        const result = await env.AI.run("@cf/facebook/bart-large-cnn", {
          input_text: text,
        });
        return securityHeadersMiddleware(jsonResponse(result));
      }

      if (pathname === "/embed") {
        const text = searchParams.get("text");
        if (!text) return securityHeadersMiddleware(jsonResponse({ error: "Missing required query param: text" }, 400));
        await quota.consumeTokens(100, "embed");
        const result = await env.AI.run("@cf/baai/bge-large-en-v1.5", {
          text,
        });
        return securityHeadersMiddleware(jsonResponse(result));
      }

      if (pathname === "/image") {
        const q = searchParams.get("q");
        if (!q) return securityHeadersMiddleware(jsonResponse({ error: "Missing required query param: q" }, 400));
        await quota.consumeTokens(200, "image");
        const result = await env.AI.run(
          "@cf/black-forest-labs/flux-1-schnell",
          { prompt: q }
        );
        return securityHeadersMiddleware(jsonResponse(result));
      }

      // --- Gemini endpoints ---

      if (pathname === "/gemini/research") {
        if (!env.GEMINI_API_KEY) return securityHeadersMiddleware(jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503));
        const q = searchParams.get("q");
        if (!q) return securityHeadersMiddleware(jsonResponse({ error: "Missing required query param: q" }, 400));
        if (q.length > 500) return securityHeadersMiddleware(jsonResponse({ error: "Query param q exceeds maximum length of 500 characters" }, 400));
        await quota.consumeTokens(1500, "gemini/research");
        // Enforce role separation: research phase must use the registered model
        assertPhaseModel("research", "gemini-1.5-flash-latest");
        const prompt =
          `You are a blog research assistant. Return a JSON object (no markdown fences) with the following keys:\n` +
          `"topic": the research topic,\n` +
          `"summary": a 2-3 sentence overview,\n` +
          `"keyPoints": an array of 5 key points suitable for a blog outline,\n` +
          `"suggestedHeadings": an array of 4-6 H2 headings for a blog post,\n` +
          `"sources": an array of up to 5 suggested reference source titles.\n` +
          `Topic: ${q}`;
        const raw = await geminiGenerate(env.GEMINI_API_KEY, prompt, "research");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { raw };
        }
        return securityHeadersMiddleware(jsonResponse(parsed));
      }

      if (pathname === "/gemini/edit") {
        if (request.method !== "POST") return securityHeadersMiddleware(jsonResponse({ error: "Method not allowed" }, 405));
        if (!env.GEMINI_API_KEY) return securityHeadersMiddleware(jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503));
        let body: { draft?: string };
        try {
          body = await request.json();
        } catch {
          return securityHeadersMiddleware(jsonResponse({ error: "Invalid JSON body" }, 400));
        }
        if (!body.draft) return securityHeadersMiddleware(jsonResponse({ error: "Missing required field: draft" }, 400));
        if (body.draft.length > 20000) return securityHeadersMiddleware(jsonResponse({ error: "Field draft exceeds maximum length of 20000 characters" }, 400));
        await quota.consumeTokens(3000, "gemini/edit");
        // Enforce role separation: edit phase must use the registered model
        assertPhaseModel("edit", "gemini-1.5-flash-latest");
        const prompt =
          `You are an expert blog editor. Revise the following blog draft to improve EEAT (Experience, Expertise, Authoritativeness, Trustworthiness), ` +
          `clarity, structure, and include a compelling call-to-action. ` +
          `Return only the revised Markdown text with no additional commentary.\n\n` +
          `DRAFT:\n${body.draft}`;
        const revised = await geminiGenerate(env.GEMINI_API_KEY, prompt, "edit");
        return securityHeadersMiddleware(jsonResponse({ revised }));
      }

      if (pathname === "/gemini/factcheck") {
        if (request.method !== "POST") return securityHeadersMiddleware(jsonResponse({ error: "Method not allowed" }, 405));
        if (!env.GEMINI_API_KEY) return securityHeadersMiddleware(jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503));
        let body: { draft?: string; sources?: { url: string; title: string; text: string }[] };
        try {
          body = await request.json();
        } catch {
          return securityHeadersMiddleware(jsonResponse({ error: "Invalid JSON body" }, 400));
        }
        if (!body.draft) return securityHeadersMiddleware(jsonResponse({ error: "Missing required field: draft" }, 400));
        if (body.draft.length > 20000) return securityHeadersMiddleware(jsonResponse({ error: "Field draft exceeds maximum length of 20000 characters" }, 400));
        await quota.consumeTokens(3000, "gemini/factcheck");
        // Enforce role separation: factcheck phase must use the registered model
        assertPhaseModel("factcheck", "gemini-1.5-flash-latest");
        const sourcesText = (body.sources ?? [])
          .map((s, i) => {
            const title = typeof s.title === "string" ? s.title : "";
            const url = typeof s.url === "string" ? s.url : "";
            const text = typeof s.text === "string" ? s.text.slice(0, 2000) : "";
            return `[${i + 1}] ${title} (${url})\n${text}`;
          })
          .join("\n\n");
        const prompt =
          `You are a fact-checking assistant. Review the blog draft below against the provided sources. ` +
          `Return a JSON object (no markdown fences) with key "findings": an array of objects each containing:\n` +
          `"claim": the specific claim from the draft,\n` +
          `"supported": true or false,\n` +
          `"sourceRef": the source title or URL that supports or contradicts it (empty string if none),\n` +
          `"suggestedRewrite": a corrected version of the claim tied to a provided source, or empty string if supported.\n\n` +
          `SOURCES:\n${sourcesText || "(none provided)"}\n\n` +
          `DRAFT:\n${body.draft}`;
        const raw = await geminiGenerate(env.GEMINI_API_KEY, prompt, "factcheck");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { raw };
        }
        return securityHeadersMiddleware(jsonResponse(parsed));
      }

      // --- Blog workflow endpoints (KV-persisted) ---

      if (pathname === "/workflow/blog") {
        if (request.method !== "POST") return securityHeadersMiddleware(jsonResponse({ error: "Method not allowed" }, 405));
        if (!env.GEMINI_API_KEY) return securityHeadersMiddleware(jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503));
        let body: { topic?: string };
        try {
          body = await request.json();
        } catch {
          return securityHeadersMiddleware(jsonResponse({ error: "Invalid JSON body" }, 400));
        }
        if (!body.topic) return securityHeadersMiddleware(jsonResponse({ error: "Missing required field: topic" }, 400));
        if (body.topic.length > 500) return securityHeadersMiddleware(jsonResponse({ error: "Field topic exceeds maximum length of 500 characters" }, 400));

        // Pre-flight quota check before starting the workflow
        await quota.consumeTokens(1500, "workflow/research");

        const workflowId = `wf_${Date.now()}_${crypto.randomUUID().split("-")[0]}`;
        const store = new WorkflowStore(env.BLOG_WORKFLOW_STATE);
        await store.create(workflowId, "research");
        await store.addLog(workflowId, "research", "phase_started", { topic: body.topic });

        try {
          // Enforce role separation: research phase must use the registered model
          assertPhaseModel("research", "gemini-1.5-flash-latest");
          const researchPrompt =
            `You are a blog research assistant. Return a JSON object (no markdown fences) with the following keys:\n` +
            `"topic": the research topic,\n` +
            `"summary": a 2-3 sentence overview,\n` +
            `"keyPoints": an array of 5 key points suitable for a blog outline,\n` +
            `"suggestedHeadings": an array of 4-6 H2 headings for a blog post,\n` +
            `"sources": an array of up to 5 suggested reference source titles.\n` +
            `Topic: ${body.topic}`;
          const raw = await geminiGenerate(env.GEMINI_API_KEY, researchPrompt, "workflow/research");
          let researchOutput: unknown;
          try {
            researchOutput = JSON.parse(raw);
          } catch {
            researchOutput = { raw };
          }
          await store.setPhaseOutput(workflowId, "research", researchOutput);
          await store.addLog(workflowId, "research", "phase_completed");
          await store.complete(workflowId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await store.setError(workflowId, "research", message);
          await store.addLog(workflowId, "research", "phase_failed", { error: message });
        }

        const state = await store.get(workflowId);
        return securityHeadersMiddleware(jsonResponse({ workflowId, state }));
      }

      // --- Python pipeline endpoints ---

      if (pathname === "/workflow/blog/outline") {
        if (request.method !== "POST") return securityHeadersMiddleware(jsonResponse({ error: "Method not allowed" }, 405));
        if (!env.GEMINI_API_KEY) return securityHeadersMiddleware(jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503));
        let body: Partial<BlogBrief>;
        try {
          body = await request.json();
        } catch {
          return securityHeadersMiddleware(jsonResponse({ error: "Invalid JSON body" }, 400));
        }
        if (!body.topic) return securityHeadersMiddleware(jsonResponse({ error: "Missing required field: topic" }, 400));
        if (String(body.topic).length > 500) return securityHeadersMiddleware(jsonResponse({ error: "Field topic exceeds maximum length of 500 characters" }, 400));

        const brief: BlogBrief = {
          topic: String(body.topic),
          audience: typeof body.audience === "string" ? body.audience : "small business owners",
          primary_keyword: typeof body.primary_keyword === "string" ? body.primary_keyword : String(body.topic),
          goal: typeof body.goal === "string" ? body.goal : "educate and convert",
          angle: typeof body.angle === "string" ? body.angle : "practical guide",
          word_count: typeof body.word_count === "number" ? body.word_count : 1200,
          sources: Array.isArray(body.sources) ? body.sources : [],
        };

        await quota.consumeTokens(1500, "workflow/outline");
        // Enforce role separation: outline phase must use the registered model
        assertPhaseModel("outline", "gemini-1.5-flash-latest");

        const workflowId = `wf_${Date.now()}_${crypto.randomUUID().split("-")[0]}`;
        const store = new WorkflowStore(env.BLOG_WORKFLOW_STATE);
        await store.create(workflowId, "outline");
        await store.addLog(workflowId, "outline", "phase_started", { topic: brief.topic });

        try {
          const prompt = buildOutlinePrompt(brief);
          const outline = await geminiGenerate(env.GEMINI_API_KEY, prompt, "workflow/outline");
          await store.setPhaseOutput(workflowId, "outline", { outline });
          await store.addLog(workflowId, "outline", "phase_completed");
          await store.complete(workflowId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await store.setError(workflowId, "outline", message);
          await store.addLog(workflowId, "outline", "phase_failed", { error: message });
        }

        const state = await store.get(workflowId);
        return securityHeadersMiddleware(jsonResponse({ workflowId, state }));
      }

      if (pathname === "/workflow/blog/draft") {
        if (request.method !== "POST") return securityHeadersMiddleware(jsonResponse({ error: "Method not allowed" }, 405));
        if (!env.GEMINI_API_KEY) return securityHeadersMiddleware(jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503));
        let body: Partial<BlogBrief> & { outline?: string };
        try {
          body = await request.json();
        } catch {
          return securityHeadersMiddleware(jsonResponse({ error: "Invalid JSON body" }, 400));
        }
        if (!body.topic) return securityHeadersMiddleware(jsonResponse({ error: "Missing required field: topic" }, 400));
        if (!body.outline) return securityHeadersMiddleware(jsonResponse({ error: "Missing required field: outline" }, 400));
        if (String(body.topic).length > 500) return securityHeadersMiddleware(jsonResponse({ error: "Field topic exceeds maximum length of 500 characters" }, 400));
        if (String(body.outline).length > 10000) return securityHeadersMiddleware(jsonResponse({ error: "Field outline exceeds maximum length of 10000 characters" }, 400));

        const brief: BlogBrief = {
          topic: String(body.topic),
          audience: typeof body.audience === "string" ? body.audience : "small business owners",
          primary_keyword: typeof body.primary_keyword === "string" ? body.primary_keyword : String(body.topic),
          goal: typeof body.goal === "string" ? body.goal : "educate and convert",
          angle: typeof body.angle === "string" ? body.angle : "practical guide",
          word_count: typeof body.word_count === "number" ? body.word_count : 1200,
          sources: Array.isArray(body.sources) ? body.sources : [],
        };

        await quota.consumeTokens(3000, "workflow/draft");
        // Enforce role separation: draft phase must use the registered model
        assertPhaseModel("draft", "gemini-1.5-flash-latest");

        const workflowId = `wf_${Date.now()}_${crypto.randomUUID().split("-")[0]}`;
        const store = new WorkflowStore(env.BLOG_WORKFLOW_STATE);
        await store.create(workflowId, "draft");
        await store.addLog(workflowId, "draft", "phase_started", { topic: brief.topic });

        try {
          const prompt = buildDraftPrompt(brief, String(body.outline));
          const draft = await geminiGenerate(env.GEMINI_API_KEY, prompt, "workflow/draft");
          await store.setPhaseOutput(workflowId, "draft", { draft });
          await store.addLog(workflowId, "draft", "phase_completed");
          await store.complete(workflowId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await store.setError(workflowId, "draft", message);
          await store.addLog(workflowId, "draft", "phase_failed", { error: message });
        }

        const state = await store.get(workflowId);
        return securityHeadersMiddleware(jsonResponse({ workflowId, state }));
      }

      if (pathname.startsWith("/workflow/") && pathname.length > "/workflow/".length) {
        const workflowId = pathname.slice("/workflow/".length);
        const store = new WorkflowStore(env.BLOG_WORKFLOW_STATE);
        const state = await store.get(workflowId);
        if (!state) return securityHeadersMiddleware(jsonResponse({ error: "Workflow not found" }, 404));
        return securityHeadersMiddleware(jsonResponse(state));
      }

      return securityHeadersMiddleware(jsonResponse({
        message: "Workers AI & Gemini endpoints",
        routes: {
          "/research?q=": "LLM research via @cf/meta/llama-3.3-70b-instruct",
          "/summarize?text=": "Summarize text via @cf/facebook/bart-large-cnn",
          "/embed?text=": "Text embeddings via @cf/baai/bge-large-en-v1.5",
          "/image?q=": "Image generation via @cf/black-forest-labs/flux-1-schnell",
          "/gemini/research?q=": "Blog research outline via Google Gemini",
          "/gemini/edit (POST)": "Blog draft editing via Google Gemini",
          "/gemini/factcheck (POST)": "Fact-checking against sources via Google Gemini",
          "/workflow/blog (POST)": "Start a persistent blog workflow execution (research phase)",
          "/workflow/blog/outline (POST)": "Run the outline pipeline (Python prompt) via Google Gemini",
          "/workflow/blog/draft (POST)": "Run the draft pipeline (Python prompt) via Google Gemini",
          "/workflow/:id (GET)": "Retrieve workflow state, phase outputs, logs, and errors",
        },
        phaseModelRegistry: PHASE_MODEL_REGISTRY,
      }));
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return securityHeadersMiddleware(
          jsonResponse({ route: pathname, error: err.message, used: err.used, limit: err.limit }, 429)
        );
      }
      if (err instanceof PhaseModelMismatchError) {
        return securityHeadersMiddleware(
          jsonResponse({ route: pathname, error: err.message, phase: err.phase, expectedModel: err.expectedModel }, 500)
        );
      }
      if (err instanceof GeminiApiError) {
        return securityHeadersMiddleware(jsonResponse({ route: pathname, error: err.message }, err.httpStatus));
      }
      const message = err instanceof Error ? err.message : String(err);
      return securityHeadersMiddleware(jsonResponse({ route: pathname, error: message }, 500));
    }
  },
};
