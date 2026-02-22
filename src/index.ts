export interface Env {
  AI: {
    run(model: string, input: unknown): Promise<unknown>;
  };
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

      return jsonResponse({
        message: "Workers AI endpoints",
        routes: {
          "/research?q=": "LLM research via @cf/meta/llama-3.3-70b-instruct",
          "/summarize?text=": "Summarize text via @cf/facebook/bart-large-cnn",
          "/embed?text=": "Text embeddings via @cf/baai/bge-large-en-v1.5",
          "/image?q=": "Image generation via @cf/black-forest-labs/flux-1-schnell",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ route: pathname, error: message }, 500);
    }
  },
};