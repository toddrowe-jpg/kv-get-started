export interface Env {
  AI: {
    run(model: string, input: unknown): Promise<unknown>;
  };
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
}

// --- Gemini helper ---

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_DEFAULT_MODEL = "gemini-1.5-flash-latest";

async function geminiGenerate(apiKey: string, prompt: string, model?: string): Promise<string> {
  const modelName = model || GEMINI_DEFAULT_MODEL;
  const url = `${GEMINI_API_BASE}${modelName}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);

    try {
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

      // --- Gemini endpoints ---

      if (pathname === "/gemini/research") {
        if (!env.GEMINI_API_KEY) return jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503);
        const q = searchParams.get("q");
        if (!q) return jsonResponse({ error: "Missing required query param: q" }, 400);
        if (q.length > 500) return jsonResponse({ error: "Query param q exceeds maximum length of 500 characters" }, 400);
        const prompt =
          `You are a blog research assistant. Return a JSON object (no markdown fences) with the following keys:\n` +
          `"topic": the research topic,\n` +
          `"summary": a 2-3 sentence overview,\n` +
          `"keyPoints": an array of 5 key points suitable for a blog outline,\n` +
          `"suggestedHeadings": an array of 4-6 H2 headings for a blog post,\n` +
          `"sources": an array of up to 5 suggested reference source titles.\n` +
          `Topic: ${q}`;
        const raw = await geminiGenerate(env.GEMINI_API_KEY, prompt, env.GEMINI_MODEL);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { raw };
        }
        return jsonResponse(parsed);
      }

      if (pathname === "/gemini/edit") {
        if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
        if (!env.GEMINI_API_KEY) return jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503);
        let body: { draft?: string };
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        if (!body.draft) return jsonResponse({ error: "Missing required field: draft" }, 400);
        if (body.draft.length > 20000) return jsonResponse({ error: "Field draft exceeds maximum length of 20000 characters" }, 400);
        const prompt =
          `You are an expert blog editor. Revise the following blog draft to improve EEAT (Experience, Expertise, Authoritativeness, Trustworthiness), ` +
          `clarity, structure, and include a compelling call-to-action. ` +
          `Return only the revised Markdown text with no additional commentary.\n\n` +
          `DRAFT:\n${body.draft}`;
        const revised = await geminiGenerate(env.GEMINI_API_KEY, prompt, env.GEMINI_MODEL);
        return jsonResponse({ revised });
      }

      if (pathname === "/gemini/factcheck") {
        if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
        if (!env.GEMINI_API_KEY) return jsonResponse({ error: "GEMINI_API_KEY not configured" }, 503);
        let body: { draft?: string; sources?: { url: string; title: string; text: string }[] };
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        if (!body.draft) return jsonResponse({ error: "Missing required field: draft" }, 400);
        if (body.draft.length > 20000) return jsonResponse({ error: "Field draft exceeds maximum length of 20000 characters" }, 400);
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
        const raw = await geminiGenerate(env.GEMINI_API_KEY, prompt, env.GEMINI_MODEL);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { raw };
        }
        return jsonResponse(parsed);
      }

      return jsonResponse({
        message: "Workers AI & Gemini endpoints",
        routes: {
          "/research?q=": "LLM research via @cf/meta/llama-3.3-70b-instruct",
          "/summarize?text=": "Summarize text via @cf/facebook/bart-large-cnn",
          "/embed?text=": "Text embeddings via @cf/baai/bge-large-en-v1.5",
          "/image?q=": "Image generation via @cf/black-forest-labs/flux-1-schnell",
          "/gemini/research?q=": "Blog research outline via Google Gemini",
          "/gemini/edit (POST)": "Blog draft editing via Google Gemini",
          "/gemini/factcheck (POST)": "Fact-checking against sources via Google Gemini",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ route: pathname, error: message }, 500);
    }
  },
};