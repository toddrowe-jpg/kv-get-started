// src/middleware.ts - Comprehensive Security Middleware

import { InputValidator, SafeTokenMath, SecurityLogger, AuthenticationMiddleware, RateLimiter, OutputSanitizer } from './security';

// Request context with security info
interface SecurityContext {
  authenticated: boolean;
  clientIp: string;
  timestamp: string;
  requestId: string;
  rateLimited: boolean;
}

// Middleware chain executor
export class MiddlewareChain {
  private middlewares: Array<(req: any, ctx: SecurityContext) => Promise<boolean>> = [];

  add(middleware: (req: any, ctx: SecurityContext) => Promise<boolean>) {
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

// Authentication middleware
export async function authenticationMiddleware(request: Request, ctx: SecurityContext): Promise<boolean> {
  const apiKeys = (process.env.API_KEYS || '').split(',');
  const auth = new AuthenticationMiddleware(apiKeys);
  
  const valid = auth.validateApiKey(request);
  if (valid) {
    ctx.authenticated = true;
    SecurityLogger.log('INFO', 'auth', { requestId: ctx.requestId, status: 'authenticated' });
  } else {
    SecurityLogger.log('WARN', 'auth', { requestId: ctx.requestId, status: 'authentication_failed', clientIp: ctx.clientIp });
  }
  
  return valid;
}

// Rate limiting middleware
export async function rateLimitMiddleware(request: Request, ctx: SecurityContext): Promise<boolean> {
  const limiter = new RateLimiter();
  const result = await limiter.checkLimit(ctx.clientIp);
  
  if (!result.allowed) {
    ctx.rateLimited = true;
    SecurityLogger.log('WARN', 'ratelimit', { clientIp: ctx.clientIp, requestId: ctx.requestId, status: 'rate_limited' });
    return false;
  }
  
  return true;
}

// Input validation middleware
export async function inputValidationMiddleware(request: Request, ctx: SecurityContext): Promise<boolean> {
  try {
    const body = await request.text();
    if (body.length > 1000000) {
      SecurityLogger.log('WARN', 'validation', { requestId: ctx.requestId, error: 'payload_too_large' });
      return false;
    }

    // Validate JSON if present
    if (request.headers.get('content-type')?.includes('application/json')) {
      try {
        JSON.parse(body);
      } catch {
        SecurityLogger.log('WARN', 'validation', { requestId: ctx.requestId, error: 'invalid_json' });
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// CORS middleware
export function corsMiddleware(request: Request): Response | null {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGINS || '*',
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

// Setup complete middleware chain
export function setupMiddlewareChain(): MiddlewareChain {
  return new MiddlewareChain()
    .add(authenticationMiddleware)
    .add(rateLimitMiddleware)
    .add(inputValidationMiddleware);
}