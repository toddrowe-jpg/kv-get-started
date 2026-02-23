// --- Gemini API types and error handling utilities ---

/** Shape of an error detail object returned by the Gemini API. */
export interface GeminiErrorDetail {
  "@type"?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

/** Shape of the error body returned by the Gemini API on failure. */
export interface GeminiErrorResponse {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: GeminiErrorDetail[];
  };
}

/** Shape of a successful Gemini API response. */
export interface GeminiSuccessResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
    finishReason?: string;
  }[];
  promptFeedback?: {
    blockReason?: string;
  };
}

/**
 * Structured error thrown when the Gemini API returns an error.
 * Includes both a human-readable message and a suggested HTTP status code
 * to forward upstream.
 */
export class GeminiApiError extends Error {
  /** Suggested HTTP status code to return to the client. */
  readonly httpStatus: number;
  /** Gemini API error status string (e.g. "RESOURCE_EXHAUSTED"). */
  readonly geminiStatus?: string;
  /** Gemini API numeric error code. */
  readonly geminiCode?: number;

  constructor(
    message: string,
    httpStatus: number,
    geminiStatus?: string,
    geminiCode?: number,
  ) {
    super(message);
    this.name = "GeminiApiError";
    this.httpStatus = httpStatus;
    this.geminiStatus = geminiStatus;
    this.geminiCode = geminiCode;
  }
}

/**
 * Maps a Gemini API error response to a {@link GeminiApiError} with an
 * appropriate upstream HTTP status code.
 *
 * @param httpStatus - The HTTP status code returned by the Gemini API.
 * @param body       - The parsed JSON body of the error response.
 * @param context    - An optional string describing which endpoint/operation
 *                     triggered the error, used in log output.
 * @returns A {@link GeminiApiError} ready to throw.
 */
export function parseGeminiError(
  httpStatus: number,
  body: GeminiErrorResponse,
  context?: string,
): GeminiApiError {
  const geminiCode = body.error?.code;
  const geminiStatus = body.error?.status;
  const geminiMessage = body.error?.message ?? "Unknown Gemini API error";

  // Map Gemini status strings / HTTP codes to meaningful upstream statuses.
  let upstreamStatus: number;
  if (httpStatus === 429 || geminiStatus === "RESOURCE_EXHAUSTED") {
    upstreamStatus = 429; // Too Many Requests / quota exceeded
  } else if (httpStatus === 401 || geminiStatus === "UNAUTHENTICATED") {
    upstreamStatus = 401; // Unauthorized – bad API key
  } else if (httpStatus === 403 || geminiStatus === "PERMISSION_DENIED") {
    upstreamStatus = 403; // Forbidden
  } else if (httpStatus === 400 || geminiStatus === "INVALID_ARGUMENT") {
    upstreamStatus = 400; // Bad request
  } else if (httpStatus >= 500) {
    upstreamStatus = 502; // Bad Gateway – upstream server error
  } else {
    upstreamStatus = 500;
  }

  const ctx = context ? ` [${context}]` : "";
  console.error(
    `Gemini API error${ctx}: HTTP ${httpStatus}, status=${geminiStatus ?? "n/a"}, code=${geminiCode ?? "n/a"}, message=${geminiMessage}`,
  );

  return new GeminiApiError(geminiMessage, upstreamStatus, geminiStatus, geminiCode);
}

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent";

/**
 * Calls the Gemini generateContent API and returns the generated text.
 *
 * @param apiKey  - The Gemini API key.
 * @param prompt  - The prompt to send.
 * @param context - Optional context label for error logging.
 * @throws {@link GeminiApiError} on API-level errors with an appropriate HTTP status.
 */
export async function geminiGenerate(
  apiKey: string,
  prompt: string,
  context?: string,
): Promise<string> {
  const res = await fetch(GEMINI_API_URL, {
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
    let body: GeminiErrorResponse = {};
    try {
      body = (await res.json()) as GeminiErrorResponse;
    } catch {
      // If the error body is not valid JSON, use an empty object so
      // parseGeminiError still produces a meaningful error.
    }
    throw parseGeminiError(res.status, body, context);
  }

  const data = (await res.json()) as GeminiSuccessResponse;

  // Surface prompt-level blocks (e.g. safety filters) as errors.
  if (data.promptFeedback?.blockReason) {
    const reason = data.promptFeedback.blockReason;
    console.error(
      `Gemini API prompt blocked${context ? ` [${context}]` : ""}: ${reason}`,
    );
    throw new GeminiApiError(`Prompt blocked by Gemini safety filters: ${reason}`, 400);
  }

  return (
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? ""
  ).trim();
}
