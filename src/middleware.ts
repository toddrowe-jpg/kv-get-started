// src/middleware.ts - Comprehensive Security Middleware

import { AuthenticationMiddleware, RateLimiter, SecurityLogger, OutputSanitizer } from './security';

// Request context with security info
interface SecurityContext {
  authenticated: boolean;
  clientIp: string;
  timestamp: string;
  requestId: string;
  rateLimited: boolean;
}

// Module-level rate limiter — shared within a Worker isolate so counters persist across requests
const _rateLimiter = new RateLimiter(60, 60_000);

// Module-level output sanitizer
const _outputSanitizer = new OutputSanitizer();

// Middleware chain executor
export class MiddlewareChain {
  private middlewares: Array<(req: Request, ctx: SecurityContext) => Promise<boolean>> = [];

  add(middleware: (req: Request, ctx: SecurityContext) => Promise<boolean>) {
    this.middlewares.push(middleware);
    return this;
  }

  async execute(request: Request): Promise<{ allowed: boolean; context: SecurityContext }> {
    const context: SecurityContext = {
      authenticated: false,
      clientIp: request.headers.get('CF-Connecting-IP') || 'unknown',
      timestamp: new Date().toISOString(),
      requestId: crypto.randomUUID(),
      rateLimited: false,
    };

    for (const middleware of this.middlewares) {
      const result = await middleware(request, context);
      if (!result) {
        SecurityLogger.error('middleware', `Middleware chain failed at step ${this.middlewares.indexOf(middleware)}`);
        return { allowed: false, context };
      }
    }

    return { allowed: true, context };
  }
}

// Authentication middleware factory — accepts the configured API key
function makeAuthMiddleware(apiKeys: string[]) {
  const auth = new AuthenticationMiddleware(apiKeys);
  return async function authenticationMiddleware(request: Request, ctx: SecurityContext): Promise<boolean> {
    const valid = auth.validateApiKey(request);
    if (valid) {
      ctx.authenticated = true;
      SecurityLogger.log('INFO', 'auth', { requestId: ctx.requestId, status: 'authenticated' });
    } else {
      SecurityLogger.log('WARN', 'auth', { requestId: ctx.requestId, status: 'authentication_failed', clientIp: ctx.clientIp });
    }
    return valid;
  };
}

// Rate limiting middleware (uses module-level limiter so state persists across requests)
export async function rateLimitMiddleware(request: Request, ctx: SecurityContext): Promise<boolean> {
  const result = _rateLimiter.checkLimit(ctx.clientIp);

  if (!result.allowed) {
    ctx.rateLimited = true;
    SecurityLogger.log('WARN', 'ratelimit', { clientIp: ctx.clientIp, requestId: ctx.requestId, status: 'rate_limited' });
    return false;
  }

  return true;
}

// Input validation middleware — checks Content-Length without consuming the body stream
export async function inputValidationMiddleware(request: Request, ctx: SecurityContext): Promise<boolean> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > 1_000_000) {
      SecurityLogger.log('WARN', 'validation', { requestId: ctx.requestId, error: 'payload_too_large' });
      return false;
    }
  }
  return true;
}

// CORS middleware
export function corsMiddleware(request: Request): Response | null {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  return null;
}

// Security headers middleware
export function securityHeadersMiddleware(response: Response): Response {
  const headers = new Headers(response.headers);

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-XSS-Protection', '1; mode=block');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Content-Security-Policy', "default-src 'self'");
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Error response handler
export function errorResponse(status: number, message: string, requestId: string): Response {
  const body = JSON.stringify({
    error: message,
    requestId,
    timestamp: new Date().toISOString(),
  });

  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Request logging middleware
export function requestLoggingMiddleware(request: Request, ctx: SecurityContext): void {
  SecurityLogger.log('INFO', 'request', {
    requestId: ctx.requestId,
    method: request.method,
    url: request.url,
    clientIp: ctx.clientIp,
    authenticated: ctx.authenticated,
    timestamp: ctx.timestamp,
  });
}

// Sanitize output data — redacts sensitive keys before sending to clients
export function sanitizeOutput(data: unknown): unknown {
  return _outputSanitizer.sanitize(data);
}

// Setup complete middleware chain — accepts the optional API key from Worker env
export function setupMiddlewareChain(apiKey?: string): MiddlewareChain {
  const apiKeys = apiKey ? [apiKey] : [];
  return new MiddlewareChain()
    .add(makeAuthMiddleware(apiKeys))
    .add(rateLimitMiddleware)
    .add(inputValidationMiddleware);
}

// Admin access guard — enforces a separate ADMIN_API_KEY for privileged endpoints.
// When ADMIN_API_KEY is configured, admin/operator/workflow-trigger routes MUST present
// it as the Bearer token. If not configured, this guard is a no-op (the outer
// middleware chain has already verified general authentication).
export function checkAdminAccess(request: Request, adminApiKey?: string): boolean {
  if (!adminApiKey) return true;
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token.length > 0 && token === adminApiKey;
}

// JWT payload shape for Cloudflare Access assertions.
interface CfAccessJwtPayload {
  aud?: string | string[];
  exp?: number;
  iss?: string;
}

// Decode a base64url-encoded string to a plain string.
function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(base64);
}

// Cloudflare Access Zero Trust guard — validates the Cf-Access-Jwt-Assertion header
// JWT audience claim and expiry. When CF_ACCESS_AUD is configured:
// - The header must be present and non-empty.
// - The JWT must be structurally valid (three base64url parts).
// - The `aud` claim must include the configured audience tag.
// - The token must not be expired.
//
// Cloudflare's network validates the RS256 signature before forwarding the request
// to the Worker. This guard confirms the assertion header has not been stripped and
// that the token was issued for the correct application.
export async function checkCfAccessJwt(request: Request, cfAccessAud?: string): Promise<boolean> {
  if (!cfAccessAud) return true;

  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.trim().length === 0) {
    SecurityLogger.log('WARN', 'cf_access', { error: 'missing_assertion_header' });
    return false;
  }

  const parts = assertion.trim().split('.');
  if (parts.length !== 3) {
    SecurityLogger.log('WARN', 'cf_access', { error: 'malformed_jwt' });
    return false;
  }

  let payload: CfAccessJwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1])) as CfAccessJwtPayload;
  } catch {
    SecurityLogger.log('WARN', 'cf_access', { error: 'jwt_payload_parse_failed' });
    return false;
  }

  // Verify the audience claim includes the configured AUD tag.
  const aud = payload.aud;
  const audMatch = Array.isArray(aud) ? aud.includes(cfAccessAud) : aud === cfAccessAud;
  if (!audMatch) {
    SecurityLogger.log('WARN', 'cf_access', { error: 'aud_mismatch', expected: cfAccessAud });
    return false;
  }

  // Verify the token has not expired.
  if (payload.exp !== undefined && Math.floor(Date.now() / 1000) > payload.exp) {
    SecurityLogger.log('WARN', 'cf_access', { error: 'token_expired' });
    return false;
  }

  return true;
}