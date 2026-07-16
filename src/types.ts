/**
 * Shared types: the RateLimiter contract every algorithm/store implements,
 * plus the gateway configuration schema.
 */

export interface RateLimitDecision {
  /** Whether this request is allowed through to the upstream. */
  allowed: boolean;
  /** The configured limit (fixed/sliding: max requests per window; token bucket: burst capacity). */
  limit: number;
  /** Requests the client may still make right now (never negative). */
  remaining: number;
  /**
   * Unix epoch seconds at which the limit fully resets
   * (window end for window algorithms; time until the bucket is full for token bucket).
   */
  resetSeconds: number;
  /** Seconds the client should wait before retrying. Only set when the request was denied. */
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  /**
   * Atomically record one request attempt for `key` and decide whether it is allowed.
   * `key` identifies one client on one route (e.g. "fixed:key:abc123").
   */
  check(key: string): Promise<RateLimitDecision>;
  /** Release timers / background resources (memory stores). */
  dispose?(): void;
}

export type Algorithm = 'fixed-window' | 'token-bucket' | 'sliding-window-log';

export interface FixedWindowParams {
  algorithm: 'fixed-window';
  limit: number;
  windowSeconds: number;
}

export interface SlidingWindowParams {
  algorithm: 'sliding-window-log';
  limit: number;
  windowSeconds: number;
}

export interface TokenBucketParams {
  algorithm: 'token-bucket';
  /** Maximum burst size (bucket capacity). */
  capacity: number;
  /** Sustained refill rate in tokens per second. Fractional values are supported. */
  refillPerSecond: number;
}

export type RateLimitParams = FixedWindowParams | SlidingWindowParams | TokenBucketParams;

/** Per-API-key override of the route's default limit parameters. */
export interface KeyOverride {
  limit?: number;
  windowSeconds?: number;
  capacity?: number;
  refillPerSecond?: number;
}

export interface RouteConfig {
  /** Optional stable identifier used in metrics labels; defaults to pathPrefix. */
  id?: string;
  /** Path prefix to match, e.g. "/api/orders". Matching respects segment boundaries. */
  pathPrefix: string;
  /** Upstream base URL, e.g. "http://127.0.0.1:9100". */
  upstream: string;
  /** When true, the prefix is removed before forwarding ("/api/orders/1" -> "/1"). */
  stripPrefix?: boolean;
  /** Upstream connect/response timeout in ms (default 10000). */
  timeoutMs?: number;
  rateLimit: RateLimitParams;
  /** Per-API-key overrides, keyed by the literal x-api-key value. */
  keyOverrides?: Record<string, KeyOverride>;
}

export interface GatewayConfig {
  listen?: { port?: number; host?: string };
  /** Trust X-Forwarded-For for client IP identity (enable only behind a trusted LB). */
  trustProxy?: boolean;
  routes: RouteConfig[];
}
