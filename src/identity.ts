import type { IncomingMessage } from 'node:http';

export interface ClientIdentity {
  /** Stable rate-limit key, e.g. "key:abc123" or "ip:127.0.0.1". */
  key: string;
  /** Present only when the client sent an x-api-key header. */
  apiKey?: string;
}

/**
 * Resolve the client identity used for rate limiting:
 * the `x-api-key` header when present, otherwise the client IP
 * (from X-Forwarded-For only when trustProxy is enabled).
 */
export function clientIdentity(req: IncomingMessage, trustProxy: boolean): ClientIdentity {
  const apiKeyHeader = req.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (apiKey) return { key: `key:${apiKey}`, apiKey };

  let ip = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw?.split(',')[0]?.trim();
    if (first) ip = first;
  }
  return { key: `ip:${ip}` };
}
