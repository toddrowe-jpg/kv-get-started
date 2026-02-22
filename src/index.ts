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