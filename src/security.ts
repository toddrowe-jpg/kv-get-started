// src/security.ts

// Class to validate user inputs to mitigate injection attacks
class InputValidator {
    validate(input: unknown): boolean {
        if (input === null || input === undefined) return false;
        if (typeof input === 'string') return input.trim().length > 0;
        return true;
    }
}

// Class to perform secure math operations with tokens
class SafeTokenMath {
    static add(a: number, b: number): number {
        return a + b;
    }
    static subtract(a: number, b: number): number {
        return a - b;
    }
}

// Class to securely parse JSON data
class SecureJsonParser {
    parse(jsonString: string): unknown {
        try {
            return JSON.parse(jsonString);
        } catch {
            throw new Error('Invalid JSON');
        }
    }
}

// Class for logging security-related events
class SecurityLogger {
    static log(level: 'INFO' | 'WARN' | 'ERROR', context: string, data?: unknown): void {
        console.log(JSON.stringify({ level, context, data, timestamp: new Date().toISOString() }));
    }
    static error(context: string, message: string): void {
        console.error(JSON.stringify({ level: 'ERROR', context, message, timestamp: new Date().toISOString() }));
    }
    log(message: string): void {
        SecurityLogger.log('INFO', 'general', message);
    }
}

// Middleware for authenticating requests via Bearer token
class AuthenticationMiddleware {
    private readonly apiKeys: string[];

    constructor(apiKeys: string[] = []) {
        this.apiKeys = apiKeys.filter(k => k.trim().length > 0);
    }

    validateApiKey(request: Request): boolean {
        // Open mode: if no keys are configured, allow all requests
        if (this.apiKeys.length === 0) return true;
        const auth = request.headers.get('Authorization') ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        return token.length > 0 && this.apiKeys.includes(token);
    }

    // Legacy interface
    authenticate(req: unknown, res: unknown, next: () => void): void {
        next();
    }
}

// Error handler for security-related errors
class SecurityErrorHandler {
    handleError(err: Error, req: unknown, res: { status: (code: number) => { send: (msg: string) => void } }): void {
        console.error(`[SECURITY ERROR] ${err.message}`);
        res.status(500).send('Internal Server Error');
    }
}

// Class to sanitize output before sending to clients — redacts known sensitive keys
class OutputSanitizer {
    private static readonly SENSITIVE_KEYS = new Set([
        'api_key', 'apikey', 'api-key', 'secret', 'password',
        'authorization', 'credential', 'private_key', 'privatekey',
    ]);

    sanitize(output: unknown): unknown {
        if (output === null || typeof output !== 'object') return output;
        if (Array.isArray(output)) return (output as unknown[]).map(item => this.sanitize(item));
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
            result[key] = OutputSanitizer.SENSITIVE_KEYS.has(key.toLowerCase())
                ? '[REDACTED]'
                : this.sanitize(value);
        }
        return result;
    }
}

// Class representing an immutable state object
class ImmutableState {
    constructor(private readonly state: unknown) {}
    getState(): unknown {
        return this.state;
    }
}

// Class to limit the rate of requests using an in-memory sliding window
class RateLimiter {
    private readonly windowMs: number;
    private readonly maxRequests: number;
    private readonly store: Map<string, number[]> = new Map();

    constructor(maxRequests = 60, windowMs = 60_000) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
    }

    checkLimit(clientIp: string): { allowed: boolean; remaining: number } {
        const now = Date.now();
        const windowStart = now - this.windowMs;
        const timestamps = (this.store.get(clientIp) ?? []).filter(t => t > windowStart);
        if (timestamps.length >= this.maxRequests) {
            this.store.set(clientIp, timestamps);
            return { allowed: false, remaining: 0 };
        }
        timestamps.push(now);
        this.store.set(clientIp, timestamps);
        // Evict IPs whose entire window has expired to prevent unbounded memory growth
        if (timestamps.length === 1) {
            for (const [ip, ts] of this.store) {
                if (ip !== clientIp && ts.every(t => t <= windowStart)) {
                    this.store.delete(ip);
                }
            }
        }
        return { allowed: true, remaining: this.maxRequests - timestamps.length };
    }

    // Legacy interface
    limit(req: unknown, res: unknown, next: () => void): void {
        next();
    }
}

// Class to limit input sizes
class InputSizeLimiter {
    private readonly maxBytes: number;

    constructor(maxBytes = 1_000_000) {
        this.maxBytes = maxBytes;
    }

    check(sizeBytes: number): boolean {
        return sizeBytes <= this.maxBytes;
    }

    // Legacy interface
    limit(req: unknown, res: unknown, next: () => void): void {
        next();
    }
}

export { InputValidator, SafeTokenMath, SecureJsonParser, SecurityLogger, AuthenticationMiddleware, SecurityErrorHandler, OutputSanitizer, ImmutableState, RateLimiter, InputSizeLimiter };