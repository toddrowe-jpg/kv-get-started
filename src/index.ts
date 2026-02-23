export interface Env {
  AI: {
    run(model: string, input: unknown): Promise<unknown>;
  };
  JOBS_KV: KVNamespace;
  ASSETS_R2: R2Bucket;
  JOBS_QUEUE: Queue<{ jobId: string }>;
  USER_NOTIFICATION: KVNamespace;
  // WordPress credentials — set via `wrangler secret put WP_USERNAME` and `wrangler secret put WP_APP_PASSWORD`
  // WP_USERNAME: string;
  // WP_APP_PASSWORD: string;
  // WhatsApp Cloud API secrets — set via `wrangler secret put <NAME>`
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  // Comma-separated E.164 numbers, e.g. "+12032755433,+447700900000"
  ADMIN_WHATSAPP_NUMBERS: string;
}

interface JobRecord {
  id: string;
  status: "queued" | "running" | "complete" | "error";
  createdAt: string;
  updatedAt: string;
  topic: string;
  site: string;
  publish: boolean;
  steps: string[];
  content?: string;
  assetUrl?: string;
  wp: {
    baseUrl: string;
    // postId will be set after WordPress publishing (future step)
    postId?: number;
  };
  error?: { step: string; message: string };
  // Approval fields (set by WhatsApp approve/reject commands)
  approval?: "approved" | "rejected";
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string;
}

// ── WhatsApp types ────────────────────────────────────────────────────────────

interface WaMessage {
  from: string;
  id: string;
  timestamp: string;
  text?: { body: string };
  type: string;
}

interface BrandProfile {
  name?: string;
  colors?: string[];
  updatedAt?: string;
}

interface PlanEntry {
  day: number;
  topic: string;
  keywords: string[];
}

// ── WhatsApp helpers ──────────────────────────────────────────────────────────

async function verifyWaSignature(
  request: Request,
  secret: string,
  rawBody: ArrayBuffer
): Promise<boolean> {
  const header = request.headers.get("X-Hub-Signature-256");
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = header.slice(7);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBody);
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computed === expected;
}

async function sendWaText(env: Env, to: string, body: string): Promise<void> {
  const url = `https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error("WA send failed:", resp.status, txt.slice(0, 200));
    }
  } catch (err) {
    console.error("WA send error:", err instanceof Error ? err.message : String(err));
  }
}

function isAdminAllowed(env: Env, waId: string): boolean {
  const allowed = (env.ADMIN_WHATSAPP_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return allowed.includes(`+${waId}`) || allowed.includes(waId);
}

async function checkRateLimit(env: Env, sender: string): Promise<boolean> {
  const key = `wa:rl:${sender}`;
  const raw = await env.JOBS_KV.get(key);
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 20;

  let count = 1;
  let windowStart = now;
  if (raw) {
    const data = JSON.parse(raw) as { count: number; windowStart: number };
    if (now - data.windowStart < windowMs) {
      count = data.count + 1;
      windowStart = data.windowStart;
    }
  }
  await env.JOBS_KV.put(key, JSON.stringify({ count, windowStart }), {
    expirationTtl: 120,
  });
  return count <= maxRequests;
}

// ── WhatsApp command handlers ─────────────────────────────────────────────────

async function handleWaCommand(
  env: Env,
  sender: string,
  text: string
): Promise<string> {
  const cmd = text.trim().replace(/\s+/g, " ");
  const lower = cmd.toLowerCase();

  // help
  if (lower === "help") {
    return [
      "📋 *Available commands:*",
      "• `brand show` — view current brand profile",
      "• `brand set name: <text>` — set brand name",
      "• `brand set colors: <hex>,<hex>,...` — set brand colors",
      "• `plan generate 30: <seed topic>` — generate 30-day content plan",
      "• `plan list` — list first 7 plan entries",
      "• `approve <jobId>` — approve a job for publishing",
      "• `reject <jobId> [reason]` — reject a job",
      "• `help` — show this message",
    ].join("\n");
  }

  // brand show
  if (lower === "brand show") {
    const raw = await env.JOBS_KV.get("brand:profile");
    if (!raw) return "No brand profile stored yet. Use `brand set name:` or `brand set colors:` to start.";
    const profile = JSON.parse(raw) as BrandProfile;
    const lines = ["*Brand Profile:*"];
    if (profile.name) lines.push(`• Name: ${profile.name}`);
    if (profile.colors?.length) lines.push(`• Colors: ${profile.colors.join(", ")}`);
    if (profile.updatedAt) lines.push(`• Updated: ${profile.updatedAt}`);
    return lines.join("\n");
  }

  // brand set name: <text>
  const nameMatch = cmd.match(/^brand set name:\s*(.+)$/i);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const raw = await env.JOBS_KV.get("brand:profile");
    const profile: BrandProfile = raw ? (JSON.parse(raw) as BrandProfile) : {};
    profile.name = name;
    profile.updatedAt = new Date().toISOString();
    await env.JOBS_KV.put("brand:profile", JSON.stringify(profile));
    return `✅ Brand name set to: *${name}*`;
  }

  // brand set colors: <hex>,<hex>,...
  const colorsMatch = cmd.match(/^brand set colors:\s*(.+)$/i);
  if (colorsMatch) {
    const parts = colorsMatch[1].split(",").map((c) => c.trim());
    const invalid = parts.filter((c) => !/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c));
    if (invalid.length > 0) {
      return `❌ Invalid hex color(s): ${invalid.join(", ")}. Use format #RRGGBB or #RGB.`;
    }
    const raw = await env.JOBS_KV.get("brand:profile");
    const profile: BrandProfile = raw ? (JSON.parse(raw) as BrandProfile) : {};
    profile.colors = parts;
    profile.updatedAt = new Date().toISOString();
    await env.JOBS_KV.put("brand:profile", JSON.stringify(profile));
    return `✅ Brand colors set to: ${parts.join(", ")}`;
  }

  // plan generate 30: <seed>
  const planGenMatch = cmd.match(/^plan generate 30:\s*(.+)$/i);
  if (planGenMatch) {
    const seed = planGenMatch[1].trim();
    let entries: PlanEntry[];

    try {
      const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
        prompt: `You are a content strategist. Generate a 30-day content plan based on the seed topic: "${seed}".
Return ONLY valid JSON: an array of 30 objects each with: "day" (1-30), "topic" (string), "keywords" (array of 1-3 long-tail keyword strings).
Example: [{"day":1,"topic":"Introduction to ${seed}","keywords":["${seed} basics","what is ${seed}"]},...]`,
        max_tokens: 1500,
      }) as { response?: string } | string;

      const raw = typeof result === "string" ? result : (result as { response?: string }).response ?? "";
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array in response");
      entries = JSON.parse(jsonMatch[0]) as PlanEntry[];
      if (!Array.isArray(entries) || entries.length === 0) throw new Error("Empty plan");
    } catch {
      // Stub fallback
      entries = Array.from({ length: 30 }, (_, i) => ({
        day: i + 1,
        topic: `${seed} — Day ${i + 1}`,
        keywords: [`${seed} tips`, `${seed} guide`, `learn ${seed}`],
      }));
    }

    await env.JOBS_KV.put("plan:current", JSON.stringify({ seed, createdAt: new Date().toISOString(), entries }));
    return `✅ 30-day plan generated for: *${seed}*\nUse \`plan list\` to see the first 7 entries.`;
  }

  // plan list
  if (lower === "plan list") {
    const raw = await env.JOBS_KV.get("plan:current");
    if (!raw) return "No plan stored yet. Use `plan generate 30: <seed>` first.";
    const plan = JSON.parse(raw) as { seed: string; entries: PlanEntry[] };
    const first7 = plan.entries.slice(0, 7);
    const lines = [`*30-Day Plan for: ${plan.seed}* (showing 7 of ${plan.entries.length})`];
    for (const e of first7) {
      lines.push(`Day ${e.day}: ${e.topic}\n  🔑 ${e.keywords.join(", ")}`);
    }
    if (plan.entries.length > 7) lines.push(`\n_(${plan.entries.length - 7} more entries — plan stored in KV)_`);
    return lines.join("\n");
  }

  // approve <jobId>
  const approveMatch = cmd.match(/^approve\s+(\S+)$/i);
  if (approveMatch) {
    const jobId = approveMatch[1];
    const job = await getJob(env, jobId);
    if (!job) return `❌ Job not found: ${jobId}`;
    job.approval = "approved";
    job.approvedAt = new Date().toISOString();
    job.approvedBy = sender;
    await putJob(env, job);
    return `✅ Job *${jobId}* approved. (Not yet published — awaiting WordPress integration.)`;
  }

  // reject <jobId> [reason]
  const rejectMatch = cmd.match(/^reject\s+(\S+)(?:\s+(.+))?$/i);
  if (rejectMatch) {
    const jobId = rejectMatch[1];
    const reason = rejectMatch[2]?.trim() ?? "";
    const job = await getJob(env, jobId);
    if (!job) return `❌ Job not found: ${jobId}`;
    job.approval = "rejected";
    job.rejectedAt = new Date().toISOString();
    job.rejectedBy = sender;
    job.rejectionReason = reason;
    await putJob(env, job);
    return `✅ Job *${jobId}* rejected.${reason ? ` Reason: ${reason}` : ""}`;
  }

  return `❓ Unknown command. Send \`help\` for a list of available commands.`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const WP_BASE_URL = "https://www.bitxcapital.com";

async function getJob(env: Env, jobId: string): Promise<JobRecord | null> {
  const raw = await env.JOBS_KV.get(`job:${jobId}`);
  if (!raw) return null;
  return JSON.parse(raw) as JobRecord;
}

async function putJob(env: Env, job: JobRecord): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await env.JOBS_KV.put(`job:${job.id}`, JSON.stringify(job));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);

    try {
      // ── Existing AI endpoints ────────────────────────────────────────────

      if (pathname === "/research") {
        const q = searchParams.get("q");
        if (!q) return jsonResponse({ error: "Missing required query param: q" }, 400);
        const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
          prompt: q,
          max_tokens: 800,
        });
        return jsonResponse(result);
      }

      if (pathname === "/summarize") {
        const text = searchParams.get("text");
        if (!text) return jsonResponse({ error: "Missing required query param: text" }, 400);
        const result = await env.AI.run("@cf/facebook/bart-large-cnn", {
          input_text: text,
        });
        return jsonResponse(result);
      }

      if (pathname === "/embed") {
        const text = searchParams.get("text");
        if (!text) return jsonResponse({ error: "Missing required query param: text" }, 400);
        const result = await env.AI.run("@cf/baai/bge-large-en-v1.5", {
          text,
        });
        return jsonResponse(result);
      }

      if (pathname === "/image") {
        const q = searchParams.get("q");
        if (!q) return jsonResponse({ error: "Missing required query param: q" }, 400);
        const result = await env.AI.run(
          "@cf/black-forest-labs/flux-1-schnell",
          { prompt: q }
        );
        return jsonResponse(result);
      }

      // ── Job pipeline endpoints ───────────────────────────────────────────

      if (pathname === "/start") {
        const topic = searchParams.get("topic");
        const site = searchParams.get("site") ?? WP_BASE_URL;
        const publishParam = searchParams.get("publish") ?? "0";
        if (!topic) return jsonResponse({ error: "Missing required query param: topic" }, 400);

        const jobId = crypto.randomUUID();
        const now = new Date().toISOString();
        const job: JobRecord = {
          id: jobId,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          topic,
          site,
          publish: publishParam === "1" || publishParam.toLowerCase() === "true",
          steps: [],
          wp: { baseUrl: WP_BASE_URL },
        };

        await putJob(env, job);
        await env.JOBS_QUEUE.send({ jobId });

        const base = new URL(request.url).origin;
        return jsonResponse({
          jobId,
          statusUrl: `${base}/status?id=${jobId}`,
          resultUrl: `${base}/result?id=${jobId}`,
        });
      }

      if (pathname === "/status") {
        const id = searchParams.get("id");
        if (!id) return jsonResponse({ error: "Missing required query param: id" }, 400);
        const job = await getJob(env, id);
        if (!job) return jsonResponse({ error: "Job not found" }, 404);
        return jsonResponse({
          id: job.id,
          status: job.status,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          steps: job.steps,
          ...(job.error ? { error: job.error } : {}),
        });
      }

      if (pathname === "/result") {
        const id = searchParams.get("id");
        if (!id) return jsonResponse({ error: "Missing required query param: id" }, 400);
        const job = await getJob(env, id);
        if (!job) return jsonResponse({ error: "Job not found" }, 404);
        return jsonResponse(job);
      }

      const assetMatch = pathname.match(/^\/asset\/([^/.]+)(?:\.[a-z]+)?$/);
      if (assetMatch) {
        const jobId = assetMatch[1];
        const obj = await env.ASSETS_R2.get(`jobs/${jobId}/image.png`);
        if (!obj) return jsonResponse({ error: "Asset not found" }, 404);
        return new Response(obj.body, {
          headers: {
            "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // ── WhatsApp webhook endpoints ────────────────────────────────────────

      if (pathname === "/whatsapp/webhook") {
        if (request.method === "GET") {
          // Meta webhook verification
          const mode = searchParams.get("hub.mode");
          const token = searchParams.get("hub.verify_token");
          const challenge = searchParams.get("hub.challenge");

          if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
            return new Response(challenge ?? "", { status: 200 });
          }
          return new Response("Forbidden", { status: 403 });
        }

        if (request.method === "POST") {
          // Read raw body for signature verification
          const rawBody = await request.arrayBuffer();

          // Verify HMAC-SHA256 signature
          if (!env.WHATSAPP_APP_SECRET) {
            console.error("WHATSAPP_APP_SECRET is not configured");
            return new Response("Service Unavailable", { status: 503 });
          }
          const sigValid = await verifyWaSignature(request, env.WHATSAPP_APP_SECRET, rawBody);
          if (!sigValid) {
            return new Response("Unauthorized", { status: 401 });
          }

          let payload: unknown;
          try {
            payload = JSON.parse(new TextDecoder().decode(rawBody));
          } catch {
            return new Response("Bad Request", { status: 400 });
          }

          // Extract messages from Cloud API payload
          const entry = (payload as { entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[] }).entry ?? [];
          for (const e of entry) {
            for (const change of e.changes ?? []) {
              const messages = change.value?.messages ?? [];
              for (const msg of messages) {
                if (msg.type !== "text" || !msg.text?.body) continue;

                const sender = msg.from; // E.164 digits without leading +

                // Admin allowlist check
                if (!isAdminAllowed(env, sender)) {
                  continue; // Silently ACK — do not retry
                }

                // Rate limit check
                const withinLimit = await checkRateLimit(env, sender);
                if (!withinLimit) {
                  await sendWaText(env, sender, "⚠️ Rate limit reached. Please wait a minute before sending more commands.");
                  continue;
                }

                const reply = await handleWaCommand(env, sender, msg.text.body);
                await sendWaText(env, sender, reply);
              }
            }
          }

          // Always return 200 to prevent Meta retries
          return new Response("OK", { status: 200 });
        }

        return new Response("Method Not Allowed", { status: 405 });
      }

      return jsonResponse({
        message: "Workers AI + Job Pipeline endpoints",
        routes: {
          "/research?q=": "LLM research via @cf/meta/llama-3.3-70b-instruct",
          "/summarize?text=": "Summarize text via @cf/facebook/bart-large-cnn",
          "/embed?text=": "Text embeddings via @cf/baai/bge-large-en-v1.5",
          "/image?q=": "Image generation via @cf/black-forest-labs/flux-1-schnell",
          "/start?topic=&site=&publish=0|1": "Enqueue a blog-writing job",
          "/status?id=": "Poll job status",
          "/result?id=": "Retrieve full job result",
          "/asset/<jobId>": "Stream generated image from R2",
          "GET /whatsapp/webhook?hub.mode=&hub.verify_token=&hub.challenge=": "Meta webhook verification",
          "POST /whatsapp/webhook": "WhatsApp inbound message handler",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ route: pathname, error: message }, 500);
    }
  },

  async queue(batch: MessageBatch<{ jobId: string }>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { jobId } = msg.body;
      const job = await getJob(env, jobId);
      if (!job) {
        msg.ack();
        continue;
      }

      let currentStep = "init";
      try {
        // Mark running
        currentStep = "starting";
        job.status = "running";
        job.steps.push(`[${new Date().toISOString()}] Starting job`);
        await putJob(env, job);

        // Step 1: Generate article content
        currentStep = "generating article content";
        job.steps.push(`[${new Date().toISOString()}] Generating article content`);
        await putJob(env, job);

        const contentResult = await env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
          prompt: `You are a professional blog writer for BITX Capital. Write a well-structured blog article on the topic: "${job.topic}". Include research notes, key points, and a full article draft. Be concise but informative.`,
          max_tokens: 800,
        }) as { response?: string } | string;

        const content =
          typeof contentResult === "string"
            ? contentResult
            : (contentResult as { response?: string })?.response ?? JSON.stringify(contentResult);

        job.content = content;
        job.steps.push(`[${new Date().toISOString()}] Article content generated`);
        await putJob(env, job);

        // Step 2: Generate image prompt
        currentStep = "generating image prompt";
        job.steps.push(`[${new Date().toISOString()}] Generating image prompt`);
        await putJob(env, job);

        const promptResult = await env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
          prompt: `Write a concise image generation prompt (max 50 words) for a blog header image about: "${job.topic}". Focus on vivid, professional visual elements.`,
          max_tokens: 100,
        }) as { response?: string } | string;

        const imagePrompt =
          typeof promptResult === "string"
            ? promptResult
            : (promptResult as { response?: string })?.response ??
              `Professional illustration for article about ${job.topic}`;

        // Step 3: Generate image
        currentStep = "generating image";
        job.steps.push(`[${new Date().toISOString()}] Generating image`);
        await putJob(env, job);

        const imgResult = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
          prompt: imagePrompt,
        }) as unknown;

        let imageData: ArrayBuffer;
        if (imgResult instanceof ReadableStream) {
          imageData = await new Response(imgResult).arrayBuffer();
        } else if (imgResult instanceof ArrayBuffer) {
          imageData = imgResult;
        } else if (
          imgResult !== null &&
          typeof imgResult === "object" &&
          "image" in imgResult &&
          typeof (imgResult as { image: unknown }).image === "string"
        ) {
          const b64 = (imgResult as { image: string }).image;
          const binaryStr = atob(b64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          imageData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        } else {
          throw new Error("Unexpected image result shape from AI model");
        }

        // Step 4: Store image in R2
        currentStep = "storing image in R2";
        const r2Key = `jobs/${jobId}/image.png`;
        await env.ASSETS_R2.put(r2Key, imageData, {
          httpMetadata: { contentType: "image/png" },
        });
        job.assetUrl = `/asset/${jobId}`;
        job.steps.push(`[${new Date().toISOString()}] Image stored at ${job.assetUrl}`);

        // Mark complete
        job.status = "complete";
        job.steps.push(`[${new Date().toISOString()}] Job complete`);
        await putJob(env, job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = "error";
        job.error = { step: currentStep, message };
        job.steps.push(`[${new Date().toISOString()}] Error during "${currentStep}": ${message}`);
        await putJob(env, job);
      }

      msg.ack();
    }
  },
};