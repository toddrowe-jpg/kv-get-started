import { GeminiApiError, geminiGenerate } from "./gemini";
import { WorkflowStore, type WorkflowEntry } from "./workflowStore";
import { QuotaStore, QuotaExceededError } from "./quotaStore";
import { wpPublishPost, WpPublishError, type WpPublishInput, type YoastMeta, type RelatedLink, type FaqItem } from "./wpPublish";
import {
  setupMiddlewareChain,
  securityHeadersMiddleware,
  corsMiddleware,
  errorResponse,
  requestLoggingMiddleware,
  sanitizeOutput,
  checkAdminAccess,
  checkCfAccessJwt,
} from "./middleware";
import {
  assertPhaseModel,
  PhaseModelMismatchError,
  PHASE_MODEL_REGISTRY,
} from "./agentRegistry";
import { buildOutlinePrompt, buildDraftPrompt, BlogBrief, runComplianceChecks } from "./pythonPipelines";
import {
  ObservabilityStore,
  isWorkflowStuck,
  sendWebhookAlert,
} from "./observability";

export interface Env {
  AI: {
    run(model: string, input: unknown): Promise<unknown>;
  };
  /** Gemini API key — must be set via: npx wrangler secret put GEMINI_API_KEY */
  GEMINI_API_KEY: string;
  /** KV namespace for persisting blog workflow state, logs, and errors. */
  BLOG_WORKFLOW_STATE: KVNamespace;
  /** Optional Bearer token for API authentication. Set via: npx wrangler secret put API_KEY */
  API_KEY?: string;
  /**
   * Optional separate Bearer token required for all /admin/* endpoints.
   * When set, admin routes reject requests that do not present this token,
   * even if the request carries a valid API_KEY.
   * Set via: npx wrangler secret put ADMIN_API_KEY
   */
  ADMIN_API_KEY?: string;
  /**
   * Optional Cloudflare Access audience tag (from your Access Application settings).
   * When set, admin and workflow-trigger endpoints additionally require the
   * Cf-Access-Jwt-Assertion header, confirming the request passed through
   * Cloudflare Zero Trust before reaching the Worker.
   * Set via: npx wrangler secret put CF_ACCESS_AUD
   */
  CF_ACCESS_AUD?: string;
  /** Optional webhook URL for external alert notifications. Set via: npx wrangler secret put ALERT_WEBHOOK_URL */
  ALERT_WEBHOOK_URL?: string;
  /**
   * WordPress site base URL (no trailing slash), e.g. https://example.kinsta.cloud
   * Set via: npx wrangler secret put WP_SITE_URL
   */
  WP_SITE_URL?: string;
  /**
   * WordPress username that owns the Application Password.
   * Set via: npx wrangler secret put WP_USER
   */
  WP_USER?: string;
  /**
   * WordPress Application Password for the user above.
   * Spaces are stripped automatically before use.
   * Set via: npx wrangler secret put WP_APP_PASSWORD
   */
  WP_APP_PASSWORD?: string;
  /**
   * WhatsApp Cloud API verify token — must match the string set in Meta webhook config.
   * Set via: npx wrangler secret put WHATSAPP_VERIFY_TOKEN
   */
  WHATSAPP_VERIFY_TOKEN?: string;
  /**
   * WhatsApp App Secret for payload signature verification.
   * Set via: npx wrangler secret put WHATSAPP_APP_SECRET
   */
  WHATSAPP_APP_SECRET?: string;
  /**
   * WhatsApp Cloud API access token for sending messages.
   * Set via: npx wrangler secret put WHATSAPP_ACCESS_TOKEN
   */
  WHATSAPP_ACCESS_TOKEN?: string;
  /**
   * WhatsApp Phone Number ID used as the sender.
   * Set via: npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
   */
  WHATSAPP_PHONE_NUMBER_ID?: string;
  /**
   * Admin WhatsApp number for internal notifications.
   * Set via: npx wrangler secret put WHATSAPP_ADMIN_NUMBER
   */
  WHATSAPP_ADMIN_NUMBER?: string;
}

/** Daily token limit used by the quota store (30 K tokens/day). */
const DAILY_TOKEN_LIMIT = 30_000;

/** Maximum allowed length for a WordPress post title. */
const WP_MAX_TITLE_LENGTH = 1_000;
/** Maximum allowed length for a WordPress post HTML content body. */
const WP_MAX_CONTENT_LENGTH = 200_000;
/** Maximum number of related links per post. */
const WP_MAX_RELATED_LINKS = 20;
/** Maximum number of FAQ items per post. */
const WP_MAX_FAQ_ITEMS = 30;
/** Maximum length for a Yoast SEO title. */
const WP_MAX_YOAST_TITLE_LENGTH = 300;
/** Maximum length for a Yoast SEO meta description. */
const WP_MAX_YOAST_DESC_LENGTH = 320;
/** Maximum length for a Yoast SEO focus keyphrase. */
const WP_MAX_YOAST_FOCUSKW_LENGTH = 200;

/** Redact a phone number, keeping only the last 4 digits. */
function redactPhone(phone: string): string {
  if (!phone || phone.length <= 4) return "****";
  return `****${phone.slice(-4)}`;
}

/** Truncate a string to at most `max` characters. */
function truncate(s: string, max = 80): string {
  if (!s || s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

const GRAPH_API_VERSION = "v25.0";

/**
 * Send a WhatsApp text message via the Cloud API.
 * Logs success (status code) and, on failure, the status and structured error fields.
 * Token values are never logged.
 */
async function sendWaText(phoneNumberId: string, accessToken: string, to: string, text: string): Promise<void> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    if (res.ok) {
      console.log("[whatsapp] auto-reply sent", res.status);
    } else {
      let errDetails: Record<string, unknown> = {};
      try {
        const json = await res.json() as { error?: Record<string, unknown>; fbtrace_id?: unknown };
        const e = json?.error ?? {};
        const raw: Record<string, unknown> = {
          message: e.message,
          type: e.type,
          code: e.code,
          error_subcode: e.error_subcode,
          error_data: e.error_data,
          // fbtrace_id may appear inside error or at top level depending on the API version
          fbtrace_id: e.fbtrace_id ?? json.fbtrace_id,
        };
        // Omit undefined fields to keep logs clean
        errDetails = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
      } catch {
        errDetails = { raw: truncate(await res.text().catch(() => "")) };
      }
      const apiPath = `/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
      console.error("[whatsapp] auto-reply failed", res.status, `path=${apiPath}`, JSON.stringify(errDetails));
    }
  } catch (err) {
    console.error("[whatsapp] auto-reply error", String(err));
  }
}

/**
 * Verify the X-Hub-Signature-256 header sent by Meta using HMAC-SHA256.
 * Returns true if the signature matches; false otherwise.
 */
async function verifyWhatsAppSignature(body: string, signature: string, secret: string): Promise<boolean> {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["verify"],
    );
    const sigHex = signature.replace(/^sha256=/, "");
    const sigBytes = new Uint8Array((sigHex.match(/.{2}/g) ?? []).map(h => parseInt(h, 16)));
    return await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(body));
  } catch {
    return false;
  }
}

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
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    // Handle CORS preflight before any other processing
    const corsResponse = corsMiddleware(request);
    if (corsResponse) return corsResponse;

    const { pathname, searchParams } = new URL(request.url);

    // ── WhatsApp Cloud API webhook (unauthenticated — Meta calls this directly) ──
    if (pathname === "/whatsapp/webhook") {
      if (request.method === "GET") {
        const mode = searchParams.get("hub.mode");
        const token = searchParams.get("hub.verify_token");
        const challenge = searchParams.get("hub.challenge");
        if (mode === "subscribe" && token && token === env.WHATSAPP_VERIFY_TOKEN) {
          return new Response(challenge ?? "", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }
        return new Response("Forbidden", { status: 403 });
      }
      if (request.method === "POST") {
        // Read raw body so we can verify signature and still parse JSON.
        const rawBody = await request.text();

        // Optional HMAC-SHA256 signature verification.
        if (env.WHATSAPP_APP_SECRET) {
          const sig = request.headers.get("X-Hub-Signature-256");
          if (!sig || !(await verifyWhatsAppSignature(rawBody, sig, env.WHATSAPP_APP_SECRET))) {
            console.warn("[whatsapp] signature verification failed");
            return new Response("Forbidden", { status: 403 });
          }
        } else {
          console.warn("[whatsapp] WHATSAPP_APP_SECRET not configured, skipping signature verification");
        }

        type WaMessage = { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } };
        type WaStatus = { id?: string; status?: string; recipient_id?: string };
        type WaChange = { field?: string; value?: { messages?: WaMessage[]; statuses?: WaStatus[] } };
        type WaBody = { object?: string; entry?: Array<{ id?: string; changes?: WaChange[] }> };

        let body: unknown = null;
        try {
          body = JSON.parse(rawBody);
        } catch {
          // ignore parse errors — still acknowledge receipt to Meta
        }

        const wa = body as WaBody | null;
        const entry0 = Array.isArray(wa?.entry) ? wa.entry[0] : undefined;
        const entryId = entry0?.id;
        const changes = entry0?.changes ?? [];
        const msgChange = changes.find(c => c.field === "messages");
        const messages = msgChange?.value?.messages ?? [];
        const statuses = msgChange?.value?.statuses ?? [];

        if (messages.length > 0) {
          const msg = messages[0];
          const logEntry: Record<string, unknown> = {
            object: wa?.object,
            entryId,
            event: "messages",
            msgId: msg.id,
            from: msg.from ? redactPhone(msg.from) : undefined,
            timestamp: msg.timestamp,
            type: msg.type,
          };
          if (msg.type === "text") logEntry.text = truncate(msg.text?.body ?? "");
          console.log("[whatsapp] inbound webhook", JSON.stringify(logEntry));

          // Auto-reply to inbound text messages.
          if (msg.type === "text" && msg.from && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
            const replyPromise = sendWaText(
              env.WHATSAPP_PHONE_NUMBER_ID,
              env.WHATSAPP_ACCESS_TOKEN,
              msg.from,
              `Received: ${msg.text?.body ?? ""}`,
            );
            // Register with the Workers runtime so the reply completes even after the response is returned.
            // In test environments (no real ctx), the promise still runs fire-and-forget.
            ctx?.waitUntil?.(replyPromise);
          }
        } else if (statuses.length > 0) {
          const st = statuses[0];
          console.log("[whatsapp] inbound webhook", JSON.stringify({
            object: wa?.object,
            entryId,
            event: "statuses",
            statusId: st.id,
            status: st.status,
            recipientId: st.recipient_id ? redactPhone(st.recipient_id) : undefined,
          }));
        } else {
          console.log("[whatsapp] inbound webhook", JSON.stringify({ object: wa?.object, entryId }));
        }

        return new Response("OK", { status: 200 });
      }
    }

    // Observability store backed by the same KV namespace used for workflow state
    const obs = new ObservabilityStore(env.BLOG_WORKFLOW_STATE);

    // Apply security middleware chain to all protected endpoints
    const chain = setupMiddlewareChain(env.API_KEY);
    const { allowed, context } = await chain.execute(request);
    requestLoggingMiddleware(request, context);

    // Log every incoming request (non-blocking)
    void obs.log({
      type: "request",
      level: "INFO",
      context: "fetch",
      data: {
        requestId: context.requestId,
        method: request.method,
        pathname,
        clientIp: context.clientIp,
        authenticated: context.authenticated,
      },
    });

    if (!allowed) {
      if (context.rateLimited) {
        // Track rate-limit hit and alert if the IP has been abusive
        const abuse = await obs.trackRateLimit(context.clientIp);
        void obs.log({
          type: "rate_limited",
          level: "WARN",
          context: "ratelimit",
          data: { requestId: context.requestId, clientIp: context.clientIp },
        });
        if (abuse.flagged) {
          const alert = await obs.createAlert({
            type: "abuse_detected",
            severity: "critical",
            message: `Abuse pattern detected from IP ${context.clientIp}: ${abuse.rateLimitHits} rate-limit hits`,
            details: abuse,
          });
          if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
        }
        return securityHeadersMiddleware(
          errorResponse(429, "Too Many Requests", context.requestId)
        );
      }
      // Auth failure: track and alert if threshold is reached
      const abuse = await obs.trackAuthFailure(context.clientIp);
      void obs.log({
        type: "auth_failure",
        level: "WARN",
        context: "auth",
        data: { requestId: context.requestId, clientIp: context.clientIp },
      });
      if (abuse.flagged) {
        const alert = await obs.createAlert({
          type: "abuse_detected",
          severity: "critical",
          message: `Abuse pattern detected from IP ${context.clientIp}: ${abuse.authFailures} auth failures`,
          details: abuse,
        });
        if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
      }
      return securityHeadersMiddleware(
        errorResponse(401, "Unauthorized: valid Bearer token required", context.requestId)
      );
    }

    // ── Admin observability endpoints (require authentication) ──────────────
    // Additional Zero Trust guard: if ADMIN_API_KEY or CF_ACCESS_AUD is configured,
    // admin routes require those credentials beyond the general API_KEY check above.
    if (pathname.startsWith("/admin/")) {
      if (!checkAdminAccess(request, env.ADMIN_API_KEY) || !(await checkCfAccessJwt(request, env.CF_ACCESS_AUD))) {
        return securityHeadersMiddleware(
          errorResponse(403, "Forbidden: admin access credentials required", context.requestId)
        );
      }
    }

    if (pathname === "/admin/logs") {
      const date = searchParams.get("date") ?? undefined;
      const logs = await obs.getLogs(date);
      return securityHeadersMiddleware(jsonResponse({ logs }));
    }

    if (pathname === "/admin/alerts") {
      const alerts = await obs.getAlerts();
      return securityHeadersMiddleware(jsonResponse({ alerts }));
    }

    if (pathname === "/admin/abuse") {
      const ip = searchParams.get("ip");
      if (!ip) return securityHeadersMiddleware(jsonResponse({ error: "Missing required query param: ip" }, 400));
      const record = await obs.getAbuseRecord(ip);
      return securityHeadersMiddleware(jsonResponse({ record }));
    }

    if (pathname === "/admin/status") {
      const store = new WorkflowStore(env.BLOG_WORKFLOW_STATE);
      const workflows = await store.list();
      const now = Date.now();
      const stats = {
        total: workflows.length,
        running: 0,
        completed: 0,
        failed: 0,
        stuck: 0,
      };
      const stuckWorkflows: WorkflowEntry[] = [];
      const failedWorkflows: WorkflowEntry[] = [];
      for (const wf of workflows) {
        if (wf.status === "running") {
          stats.running++;
          if (isWorkflowStuck(wf)) {
            stats.stuck++;
            stuckWorkflows.push(wf);
          }
        } else if (wf.status === "completed") {
          stats.completed++;
        } else if (wf.status === "failed") {
          stats.failed++;
          failedWorkflows.push(wf);
        }
      }
      return securityHeadersMiddleware(jsonResponse({
        generatedAt: new Date(now).toISOString(),
        stats,
        stuckWorkflows,
        failedWorkflows,
        recentWorkflows: workflows.slice(0, 20),
      }));
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
          const alert = await obs.createAlert({
            type: "workflow_failed",
            severity: "critical",
            message: `Workflow ${workflowId} failed at phase "research": ${message}`,
            details: { workflowId, phase: "research", error: message },
          });
          if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
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
          const alert = await obs.createAlert({
            type: "workflow_failed",
            severity: "critical",
            message: `Workflow ${workflowId} failed at phase "outline": ${message}`,
            details: { workflowId, phase: "outline", error: message },
          });
          if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
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
          const alert = await obs.createAlert({
            type: "workflow_failed",
            severity: "critical",
            message: `Workflow ${workflowId} failed at phase "draft": ${message}`,
            details: { workflowId, phase: "draft", error: message },
          });
          if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
        }

        const state = await store.get(workflowId);
        return securityHeadersMiddleware(jsonResponse({ workflowId, state }));
      }

      if (pathname === "/workflow/execute") {
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

        // Pre-flight quota check covering all three phases (≈2 000 tokens per phase × 3)
        await quota.consumeTokens(6000, "workflow/execute");

        const workflowId = `wf_${Date.now()}_${crypto.randomUUID().split("-")[0]}`;
        const store = new WorkflowStore(env.BLOG_WORKFLOW_STATE);
        await store.create(workflowId, "research");

        // ── Phase 1: Research ────────────────────────────────────────────────
        await store.addLog(workflowId, "research", "phase_started", { topic: brief.topic });
        let researchFailed = false;
        let researchOutput: unknown = null;

        try {
          assertPhaseModel("research", "gemini-1.5-flash-latest");
          const researchPrompt =
            `You are a blog research assistant. Return a JSON object (no markdown fences) with the following keys:\n` +
            `"topic": the research topic,\n` +
            `"summary": a 2-3 sentence overview,\n` +
            `"keyPoints": an array of 5 key points suitable for a blog outline,\n` +
            `"suggestedHeadings": an array of 4-6 H2 headings for a blog post,\n` +
            `"sources": an array of up to 5 suggested reference source titles.\n` +
            `Topic: ${brief.topic}`;
          const raw = await geminiGenerate(env.GEMINI_API_KEY, researchPrompt, "workflow/execute/research");
          try {
            researchOutput = JSON.parse(raw);
          } catch {
            researchOutput = { raw };
          }
          await store.setPhaseOutput(workflowId, "research", researchOutput);
          await store.addLog(workflowId, "research", "phase_completed");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await store.setError(workflowId, "research", message);
          await store.addLog(workflowId, "research", "phase_failed", { error: message });
          const alert = await obs.createAlert({
            type: "workflow_failed",
            severity: "critical",
            message: `Workflow ${workflowId} failed at phase "research": ${message}`,
            details: { workflowId, phase: "research", error: message },
          });
          if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
          researchFailed = true;
        }

        // ── Phase 2: Outline ────────────────────────────────────────────────
        let outlineFailed = false;
        let outlineText = "";

        if (!researchFailed) {
          await store.addLog(workflowId, "outline", "phase_started", { topic: brief.topic });
          try {
            assertPhaseModel("outline", "gemini-1.5-flash-latest");
            const outlinePrompt = buildOutlinePrompt(brief);
            outlineText = await geminiGenerate(env.GEMINI_API_KEY, outlinePrompt, "workflow/execute/outline");
            await store.setPhaseOutput(workflowId, "outline", { outline: outlineText });
            await store.addLog(workflowId, "outline", "phase_completed");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await store.setError(workflowId, "outline", message);
            await store.addLog(workflowId, "outline", "phase_failed", { error: message });
            const alert = await obs.createAlert({
              type: "workflow_failed",
              severity: "critical",
              message: `Workflow ${workflowId} failed at phase "outline": ${message}`,
              details: { workflowId, phase: "outline", error: message },
            });
            if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
            outlineFailed = true;
          }
        }

        // ── Phase 3: Draft ────────────────────────────────────────────────
        let draftText = "";
        let draftFailed = false;
        if (!researchFailed && !outlineFailed) {
          await store.addLog(workflowId, "draft", "phase_started", { topic: brief.topic });
          try {
            assertPhaseModel("draft", "gemini-1.5-flash-latest");
            const draftPrompt = buildDraftPrompt(brief, outlineText);
            draftText = await geminiGenerate(env.GEMINI_API_KEY, draftPrompt, "workflow/execute/draft");
            await store.setPhaseOutput(workflowId, "draft", { draft: draftText });
            await store.addLog(workflowId, "draft", "phase_completed");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await store.setError(workflowId, "draft", message);
            await store.addLog(workflowId, "draft", "phase_failed", { error: message });
            const alert = await obs.createAlert({
              type: "workflow_failed",
              severity: "critical",
              message: `Workflow ${workflowId} failed at phase "draft": ${message}`,
              details: { workflowId, phase: "draft", error: message },
            });
            if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
            draftFailed = true;
          }
        }

        // ── Phase 4: Compliance ─────────────────────────────────────────────
        // Rule-based compliance, SEO, grammar, and forbidden-phrase validation.
        // Violations are logged to KV but do NOT fail the workflow so that all
        // issues are surfaced to the caller even when the draft is otherwise good.
        if (!researchFailed && !outlineFailed && !draftFailed) {
          await store.addLog(workflowId, "compliance", "phase_started", { topic: brief.topic });
          let complianceFailed = false;
          try {
            assertPhaseModel("compliance", "rule-based");
            const violations = runComplianceChecks(draftText, brief.primary_keyword);
            for (const v of violations) {
              await store.addLog(workflowId, "compliance", "violation_found", {
                rule: v.rule,
                message: v.message,
              });
            }
            await store.setPhaseOutput(workflowId, "compliance", { violations });
            await store.addLog(workflowId, "compliance", "phase_completed", {
              violationCount: violations.length,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await store.setError(workflowId, "compliance", message);
            await store.addLog(workflowId, "compliance", "phase_failed", { error: message });
            complianceFailed = true;
          }
          if (!complianceFailed) {
            await store.complete(workflowId);
          }
        }

        const state = await store.get(workflowId);
        return securityHeadersMiddleware(jsonResponse({ workflowId, state }));
      }

      if (pathname.startsWith("/workflow/") && pathname.length > "/workflow/".length) {
        const workflowId = pathname.slice("/workflow/".length);
        const store = new WorkflowStore(env.BLOG_WORKFLOW_STATE);
        const state = await store.get(workflowId);
        if (!state) return securityHeadersMiddleware(jsonResponse({ error: "Workflow not found" }, 404));
        // Alert if workflow appears stuck (still running after threshold)
        if (isWorkflowStuck(state)) {
          const alert = await obs.createAlert({
            type: "workflow_stuck",
            severity: "warning",
            message: `Workflow ${workflowId} has been in "running" state for more than 5 minutes`,
            details: { workflowId, phase: state.currentPhase, updatedAt: state.updatedAt },
          });
          if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
        }
        return securityHeadersMiddleware(jsonResponse(state));
      }

      // --- WordPress publishing endpoint ---

      if (pathname === "/wp/publish") {
        if (request.method !== "POST") return securityHeadersMiddleware(jsonResponse({ error: "Method not allowed" }, 405));
        if (!env.WP_SITE_URL) return securityHeadersMiddleware(jsonResponse({ error: "WP_SITE_URL not configured" }, 503));
        if (!env.WP_USER) return securityHeadersMiddleware(jsonResponse({ error: "WP_USER not configured" }, 503));
        if (!env.WP_APP_PASSWORD) return securityHeadersMiddleware(jsonResponse({ error: "WP_APP_PASSWORD not configured" }, 503));

        let body: Partial<WpPublishInput>;
        try {
          body = await request.json();
        } catch {
          return securityHeadersMiddleware(jsonResponse({ error: "Invalid JSON body" }, 400));
        }

        if (!body.title) return securityHeadersMiddleware(jsonResponse({ error: "Missing required field: title" }, 400));
        // Accept either `contentHtml` or `content` (alias)
        const rawBody = body as Record<string, unknown>;
        const rawContent = body.contentHtml ?? (typeof rawBody.content === "string" ? rawBody.content : undefined);
        if (!rawContent) return securityHeadersMiddleware(jsonResponse({ error: "Missing required field: contentHtml" }, 400));
        if (typeof body.title !== "string" || body.title.trim().length === 0) {
          return securityHeadersMiddleware(jsonResponse({ error: "Field title must be a non-empty string" }, 400));
        }
        if (body.title.length > WP_MAX_TITLE_LENGTH) return securityHeadersMiddleware(jsonResponse({ error: `Field title exceeds maximum length of ${WP_MAX_TITLE_LENGTH} characters` }, 400));
        if (typeof rawContent !== "string" || rawContent.trim().length === 0) {
          return securityHeadersMiddleware(jsonResponse({ error: "Field contentHtml must be a non-empty string" }, 400));
        }
        if (rawContent.length > WP_MAX_CONTENT_LENGTH) return securityHeadersMiddleware(jsonResponse({ error: `Field contentHtml exceeds maximum length of ${WP_MAX_CONTENT_LENGTH} characters` }, 400));
        if (
          body.status !== undefined &&
          !["draft", "publish", "pending", "private"].includes(body.status)
        ) {
          return securityHeadersMiddleware(jsonResponse({ error: "Field status must be one of: draft, publish, pending, private" }, 400));
        }

        // Validate yoast (optional)
        let yoast: YoastMeta | undefined;
        if (body.yoast !== undefined) {
          if (typeof body.yoast !== "object" || Array.isArray(body.yoast) || body.yoast === null) {
            return securityHeadersMiddleware(jsonResponse({ error: "Field yoast must be an object" }, 400));
          }
          const y = body.yoast as Record<string, unknown>;
          if (y.title !== undefined) {
            if (typeof y.title !== "string") return securityHeadersMiddleware(jsonResponse({ error: "Field yoast.title must be a string" }, 400));
            if ((y.title as string).length > WP_MAX_YOAST_TITLE_LENGTH) return securityHeadersMiddleware(jsonResponse({ error: `Field yoast.title exceeds maximum length of ${WP_MAX_YOAST_TITLE_LENGTH} characters` }, 400));
          }
          if (y.description !== undefined) {
            if (typeof y.description !== "string") return securityHeadersMiddleware(jsonResponse({ error: "Field yoast.description must be a string" }, 400));
            if ((y.description as string).length > WP_MAX_YOAST_DESC_LENGTH) return securityHeadersMiddleware(jsonResponse({ error: `Field yoast.description exceeds maximum length of ${WP_MAX_YOAST_DESC_LENGTH} characters` }, 400));
          }
          if (y.focuskw !== undefined) {
            if (typeof y.focuskw !== "string") return securityHeadersMiddleware(jsonResponse({ error: "Field yoast.focuskw must be a string" }, 400));
            if ((y.focuskw as string).length > WP_MAX_YOAST_FOCUSKW_LENGTH) return securityHeadersMiddleware(jsonResponse({ error: `Field yoast.focuskw exceeds maximum length of ${WP_MAX_YOAST_FOCUSKW_LENGTH} characters` }, 400));
          }
          yoast = body.yoast;
        }

        // Validate relatedLinks (optional)
        let relatedLinks: RelatedLink[] | undefined;
        if (body.relatedLinks !== undefined) {
          if (!Array.isArray(body.relatedLinks)) {
            return securityHeadersMiddleware(jsonResponse({ error: "Field relatedLinks must be an array" }, 400));
          }
          if (body.relatedLinks.length > WP_MAX_RELATED_LINKS) {
            return securityHeadersMiddleware(jsonResponse({ error: `Field relatedLinks exceeds maximum of ${WP_MAX_RELATED_LINKS} items` }, 400));
          }
          for (let i = 0; i < body.relatedLinks.length; i++) {
            const link = body.relatedLinks[i] as unknown as Record<string, unknown>;
            if (typeof link?.title !== "string" || (link.title as string).trim().length === 0) {
              return securityHeadersMiddleware(jsonResponse({ error: `relatedLinks[${i}].title must be a non-empty string` }, 400));
            }
            if (typeof link?.url !== "string" || (link.url as string).trim().length === 0) {
              return securityHeadersMiddleware(jsonResponse({ error: `relatedLinks[${i}].url must be a non-empty string` }, 400));
            }
            try { new URL(link.url as string); } catch {
              return securityHeadersMiddleware(jsonResponse({ error: `relatedLinks[${i}].url is not a valid URL` }, 400));
            }
          }
          relatedLinks = body.relatedLinks as RelatedLink[];
        }

        // Validate faq (optional)
        let faq: FaqItem[] | undefined;
        if (body.faq !== undefined) {
          if (!Array.isArray(body.faq)) {
            return securityHeadersMiddleware(jsonResponse({ error: "Field faq must be an array" }, 400));
          }
          if (body.faq.length > WP_MAX_FAQ_ITEMS) {
            return securityHeadersMiddleware(jsonResponse({ error: `Field faq exceeds maximum of ${WP_MAX_FAQ_ITEMS} items` }, 400));
          }
          for (let i = 0; i < body.faq.length; i++) {
            const item = body.faq[i] as unknown as Record<string, unknown>;
            if (typeof item?.question !== "string" || (item.question as string).trim().length === 0) {
              return securityHeadersMiddleware(jsonResponse({ error: `faq[${i}].question must be a non-empty string` }, 400));
            }
            if (item.answerHtml !== undefined && typeof item.answerHtml !== "string") {
              return securityHeadersMiddleware(jsonResponse({ error: `faq[${i}].answerHtml must be a string` }, 400));
            }
            if (item.answerText !== undefined && typeof item.answerText !== "string") {
              return securityHeadersMiddleware(jsonResponse({ error: `faq[${i}].answerText must be a string` }, 400));
            }
          }
          faq = body.faq as FaqItem[];
        }

        const input: WpPublishInput = {
          title: body.title.trim(),
          contentHtml: rawContent,
          status: body.status ?? "draft",
          categories: Array.isArray(body.categories) ? body.categories : [],
          tags: Array.isArray(body.tags) ? body.tags : [],
          yoast,
          relatedLinks,
          faq,
          includeApplyNowButton: typeof body.includeApplyNowButton === "boolean" ? body.includeApplyNowButton : true,
        };

        const result = await wpPublishPost(env.WP_SITE_URL, env.WP_USER, env.WP_APP_PASSWORD, input);
        return securityHeadersMiddleware(jsonResponse(result, 201));
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
          "/workflow/execute (POST)": "Run the full workflow end-to-end (research → outline → draft) in a single call",
          "/workflow/:id (GET)": "Retrieve workflow state, phase outputs, logs, and errors",
          "/wp/publish (POST)": "Publish or draft a post to WordPress as Gutenberg blocks with optional Yoast SEO meta, Apply Now button, Related Links, and Yoast FAQ block",
          "/admin/logs?date= (GET)": "Retrieve observability event logs for a given date (default: today)",
          "/admin/alerts (GET)": "Retrieve all stored alerts",
          "/admin/abuse?ip= (GET)": "Retrieve abuse record for a specific IP address",
          "/admin/status (GET)": "Retrieve aggregated workflow run statistics (total, running, completed, failed, stuck)",
        },
        phaseModelRegistry: PHASE_MODEL_REGISTRY,
      }));
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        void obs.log({ type: "quota_exceeded", level: "ERROR", context: pathname, data: { used: err.used, limit: err.limit } });
        const alert = await obs.createAlert({
          type: "quota_exceeded",
          severity: "warning",
          message: `Daily token quota exceeded on ${pathname}: ${err.used}/${err.limit} tokens used`,
          details: { route: pathname, used: err.used, limit: err.limit },
        });
        if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
        return securityHeadersMiddleware(
          jsonResponse({ route: pathname, error: err.message, used: err.used, limit: err.limit }, 429)
        );
      }
      if (err instanceof PhaseModelMismatchError) {
        void obs.log({ type: "error", level: "ERROR", context: pathname, data: { phase: err.phase, expectedModel: err.expectedModel } });
        return securityHeadersMiddleware(
          jsonResponse({ route: pathname, error: err.message, phase: err.phase, expectedModel: err.expectedModel }, 500)
        );
      }
      if (err instanceof GeminiApiError) {
        void obs.log({ type: "error", level: "ERROR", context: pathname, data: { geminiStatus: err.geminiStatus, httpStatus: err.httpStatus, message: err.message } });
        const alert = await obs.createAlert({
          type: "api_error",
          severity: err.httpStatus >= 500 ? "critical" : "warning",
          message: `Gemini API error on ${pathname}: ${err.message}`,
          details: { route: pathname, geminiStatus: err.geminiStatus, httpStatus: err.httpStatus },
        });
        if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
        return securityHeadersMiddleware(jsonResponse({ route: pathname, error: err.message }, err.httpStatus));
      }
      if (err instanceof WpPublishError) {
        void obs.log({ type: "error", level: "ERROR", context: pathname, data: { wpStatus: err.wpStatus, message: err.message } });
        // Propagate 4xx errors from WP as-is; map 5xx and unexpected status codes to 502
        const httpStatus = err.wpStatus >= 400 && err.wpStatus < 500 ? err.wpStatus : 502;
        return securityHeadersMiddleware(jsonResponse({ route: pathname, error: err.message, wpStatus: err.wpStatus }, httpStatus));
      }
      const message = err instanceof Error ? err.message : String(err);
      void obs.log({ type: "error", level: "ERROR", context: pathname, data: { message } });
      const alert = await obs.createAlert({
        type: "api_error",
        severity: "critical",
        message: `Unhandled error on ${pathname}: ${message}`,
        details: { route: pathname, error: message },
      });
      if (env.ALERT_WEBHOOK_URL) await sendWebhookAlert(env.ALERT_WEBHOOK_URL, alert);
      return securityHeadersMiddleware(jsonResponse({ route: pathname, error: message }, 500));
    }
  },
};
