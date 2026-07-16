import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  requestsTotal: Counter<'route' | 'method' | 'status'>;
  rateLimitedTotal: Counter<'route' | 'algorithm'>;
  upstreamErrorsTotal: Counter<'route'>;
  requestDuration: Histogram<'route' | 'method' | 'status'>;
}

/**
 * Each gateway instance gets its own Registry so tests can create
 * many gateways in one process without name collisions.
 */
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requestsTotal = new Counter({
    name: 'gateway_http_requests_total',
    help: 'Total HTTP requests handled by the gateway, by route/method/status.',
    labelNames: ['route', 'method', 'status'] as const,
    registers: [registry],
  });

  const rateLimitedTotal = new Counter({
    name: 'gateway_rate_limited_total',
    help: 'Requests rejected with 429 by route and algorithm.',
    labelNames: ['route', 'algorithm'] as const,
    registers: [registry],
  });

  const upstreamErrorsTotal = new Counter({
    name: 'gateway_upstream_errors_total',
    help: 'Proxy attempts that failed with an upstream error (502).',
    labelNames: ['route'] as const,
    registers: [registry],
  });

  const requestDuration = new Histogram({
    name: 'gateway_http_request_duration_seconds',
    help: 'End-to-end request latency observed by the gateway.',
    labelNames: ['route', 'method', 'status'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  return { registry, requestsTotal, rateLimitedTotal, upstreamErrorsTotal, requestDuration };
}
