import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import type { GatewayConfig, RateLimitDecision, RateLimiter, RateLimitParams, RouteConfig } from './types';
import { createMetrics } from './metrics';
import { clientIdentity } from './identity';
import { proxyRequest } from './proxy';
import { createLimiter, type StoreContext } from './limiters/factory';
import type { RedisScriptRunner } from './limiters/redis/runScript';

export interface GatewayOptions {
  /** Overrides config.listen.port (tests pass 0 for an ephemeral port). */
  port?: number;
  host?: string;
  /** Overrides process.env.REDIS_URL. Empty string forces memory store. */
  redisUrl?: string;
  /** Injectable clock for memory limiters (tests). */
  now?: () => number;
}

export interface Gateway {
  server: http.Server;
  port: number;
  storeKind: 'memory' | 'redis';
  close(): Promise<void>;
}

/** True when `path` starts with `prefix` at a path-segment boundary. */
function matchesPrefix(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  if (path.length === prefix.length) return true;
  if (prefix.endsWith('/')) return true;
  return path.charAt(prefix.length) === '/';
}

/** Merge a per-API-key override into the route's default limit params. */
function resolveParams(route: RouteConfig, apiKey?: string): RateLimitParams {
  const base = route.rateLimit;
  const override = apiKey ? route.keyOverrides?.[apiKey] : undefined;
  if (!override) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged as unknown as RateLimitParams;
}

export async function startGateway(config: GatewayConfig, opts: GatewayOptions = {}): Promise<Gateway> {
  const metrics = createMetrics();

  const redisUrl = opts.redisUrl !== undefined ? opts.redisUrl : process.env.REDIS_URL;
  let redis: Redis | undefined;
  let store: StoreContext;
  if (redisUrl) {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
    redis.on('error', (err) => {
      console.error(`[gateway] redis error: ${err.message}`);
    });
    store = { kind: 'redis', client: redis as unknown as RedisScriptRunner };
  } else {
    store = { kind: 'memory', now: opts.now };
  }

  // One limiter instance per (route, resolved params) — per-key overrides get
  // their own instance because their parameters differ. State is still keyed
  // per client inside each limiter.
  const limiterCache = new Map<string, RateLimiter>();
  const getLimiter = (routeLabel: string, params: RateLimitParams): RateLimiter => {
    const cacheKey = `${routeLabel}|${JSON.stringify(params)}`;
    let limiter = limiterCache.get(cacheKey);
    if (!limiter) {
      limiter = createLimiter(params, store);
      limiterCache.set(cacheKey, limiter);
    }
    return limiter;
  };

  // Longest prefix wins.
  const routes = [...config.routes].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  const trustProxy = config.trustProxy ?? false;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: Error) => {
      console.error(`[gateway] unhandled error: ${err.stack ?? err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startNs = process.hrtime.bigint();
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const pathOnly = rawUrl.split('?')[0];
    let routeLabel = 'unmatched';

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      const status = String(res.statusCode);
      metrics.requestsTotal.inc({ route: routeLabel, method, status });
      metrics.requestDuration.observe({ route: routeLabel, method, status }, seconds);
    });

    if (pathOnly === '/metrics') {
      routeLabel = '/metrics';
      const body = await metrics.registry.metrics();
      res.writeHead(200, { 'content-type': metrics.registry.contentType });
      res.end(body);
      return;
    }

    if (pathOnly === '/healthz') {
      routeLabel = '/healthz';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', store: store.kind }));
      return;
    }

    const route = routes.find((r) => matchesPrefix(pathOnly, r.pathPrefix));
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no_route', path: pathOnly }));
      return;
    }
    routeLabel = route.id ?? route.pathPrefix;

    const ident = clientIdentity(req, trustProxy);
    const params = resolveParams(route, ident.apiKey);
    const limiter = getLimiter(routeLabel, params);

    let decision: RateLimitDecision | undefined;
    try {
      decision = await limiter.check(`${routeLabel}:${ident.key}`);
    } catch (err) {
      // Fail-open: when the limiter backend (Redis) is unreachable we prefer
      // serving traffic unthrottled over a full outage. See README trade-offs.
      console.error(`[gateway] limiter backend error (failing open): ${(err as Error).message}`);
    }

    if (decision) {
      res.setHeader('X-RateLimit-Limit', String(decision.limit));
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
      res.setHeader('X-RateLimit-Reset', String(decision.resetSeconds));

      if (!decision.allowed) {
        const retryAfter = decision.retryAfterSeconds ?? 1;
        metrics.rateLimitedTotal.inc({ route: routeLabel, algorithm: params.algorithm });
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(retryAfter),
        });
        res.end(
          JSON.stringify({
            error: 'rate_limited',
            message: 'Too many requests',
            retryAfterSeconds: retryAfter,
          }),
        );
        return;
      }
    }

    proxyRequest(req, res, route, {
      onUpstreamError: () => metrics.upstreamErrorsTotal.inc({ route: routeLabel }),
    });
  }

  const port = opts.port ?? config.listen?.port ?? 8080;
  const host = opts.host ?? config.listen?.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;

  return {
    server,
    port: boundPort,
    storeKind: store.kind,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
      for (const limiter of limiterCache.values()) limiter.dispose?.();
      limiterCache.clear();
      if (redis) {
        try {
          await redis.quit();
        } catch {
          redis.disconnect();
        }
      }
    },
  };
}
