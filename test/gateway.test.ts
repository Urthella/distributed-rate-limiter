import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGateway, type Gateway } from '../src/gateway';

interface TestUpstream {
  port: number;
  close(): Promise<void>;
}

function startTestUpstream(): Promise<TestUpstream> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'test' });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          bodyBytes: Buffer.concat(chunks).length,
          apiKey: req.headers['x-api-key'] ?? null,
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((res2, rej) => {
            server.close((err) => (err ? rej(err) : res2()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

describe('gateway integration (upstream + gateway on ephemeral ports)', () => {
  let upstream: TestUpstream;
  let gateway: Gateway;
  let base: string;

  beforeAll(async () => {
    upstream = await startTestUpstream();
    gateway = await startGateway(
      {
        trustProxy: false,
        routes: [
          {
            id: 'fw',
            pathPrefix: '/api/fw',
            upstream: `http://127.0.0.1:${upstream.port}`,
            stripPrefix: true,
            rateLimit: { algorithm: 'fixed-window', limit: 3, windowSeconds: 60 },
            keyOverrides: { 'vip-key': { limit: 50 } },
          },
          {
            id: 'tb',
            pathPrefix: '/api/tb',
            upstream: `http://127.0.0.1:${upstream.port}`,
            rateLimit: { algorithm: 'token-bucket', capacity: 2, refillPerSecond: 0.1 },
          },
          {
            id: 'sw',
            pathPrefix: '/api/sw',
            upstream: `http://127.0.0.1:${upstream.port}`,
            rateLimit: { algorithm: 'sliding-window-log', limit: 2, windowSeconds: 60 },
          },
          {
            id: 'bad',
            pathPrefix: '/api/bad',
            upstream: 'http://127.0.0.1:1', // nothing listens here -> 502
            timeoutMs: 2_000,
            rateLimit: { algorithm: 'fixed-window', limit: 100, windowSeconds: 60 },
          },
        ],
      },
      { port: 0, redisUrl: '' }, // ephemeral port, force memory store
    );
    base = `http://127.0.0.1:${gateway.port}`;
  });

  afterAll(async () => {
    await gateway.close();
    await upstream.close();
  });

  it('proxies requests preserving method, path, query and body', async () => {
    const res = await fetch(`${base}/api/fw/echo?x=1`, {
      method: 'POST',
      headers: { 'x-api-key': 'proxy-check', 'content-type': 'text/plain' },
      body: 'hello world',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-upstream')).toBe('test'); // upstream headers pass through
    const body = (await res.json()) as { method: string; url: string; bodyBytes: number; apiKey: string };
    expect(body.method).toBe('POST');
    expect(body.url).toBe('/echo?x=1'); // stripPrefix applied
    expect(body.bodyBytes).toBe(11);
    expect(body.apiKey).toBe('proxy-check');
  });

  it('sends X-RateLimit-* headers on allowed responses and counts down', async () => {
    const key = 'headers-key';
    const first = await fetch(`${base}/api/fw/a`, { headers: { 'x-api-key': key } });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('3');
    expect(first.headers.get('x-ratelimit-remaining')).toBe('2');
    expect(Number(first.headers.get('x-ratelimit-reset'))).toBeGreaterThan(Date.now() / 1000);
    await first.arrayBuffer();

    const second = await fetch(`${base}/api/fw/a`, { headers: { 'x-api-key': key } });
    expect(second.headers.get('x-ratelimit-remaining')).toBe('1');
    await second.arrayBuffer();
  });

  it('returns 429 with Retry-After once the limit is exhausted', async () => {
    const key = 'exhaust-key';
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/fw/x`, { headers: { 'x-api-key': key } });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    const limited = await fetch(`${base}/api/fw/x`, { headers: { 'x-api-key': key } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit')).toBe('3');
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const body = (await limited.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });

  it('isolates limits per API key', async () => {
    const keyA = 'iso-a';
    const keyB = 'iso-b';
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/fw/iso`, { headers: { 'x-api-key': keyA } });
      await res.arrayBuffer();
    }
    const aLimited = await fetch(`${base}/api/fw/iso`, { headers: { 'x-api-key': keyA } });
    expect(aLimited.status).toBe(429);
    await aLimited.arrayBuffer();

    const bAllowed = await fetch(`${base}/api/fw/iso`, { headers: { 'x-api-key': keyB } });
    expect(bAllowed.status).toBe(200); // key B untouched by key A's spend
    expect(bAllowed.headers.get('x-ratelimit-remaining')).toBe('2');
    await bAllowed.arrayBuffer();
  });

  it('applies per-key overrides from config', async () => {
    const res = await fetch(`${base}/api/fw/vip`, { headers: { 'x-api-key': 'vip-key' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('50'); // overridden from 3
    expect(res.headers.get('x-ratelimit-remaining')).toBe('49');
    await res.arrayBuffer();
  });

  it('enforces token bucket burst on a route', async () => {
    const key = 'tb-key';
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/api/tb/x`, { headers: { 'x-api-key': key } });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses.slice(0, 2)).toEqual([200, 200]); // burst capacity 2
    expect(statuses[2]).toBe(429);
    expect(statuses[3]).toBe(429);
  });

  it('enforces sliding window log on a route', async () => {
    const key = 'sw-key';
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/sw/x`, { headers: { 'x-api-key': key } });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('returns 404 for unmatched paths and respects segment boundaries', async () => {
    const miss = await fetch(`${base}/nope`);
    expect(miss.status).toBe(404);
    await miss.arrayBuffer();

    // "/api/fwx" must NOT match the "/api/fw" prefix.
    const boundary = await fetch(`${base}/api/fwx`);
    expect(boundary.status).toBe(404);
    await boundary.arrayBuffer();
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const res = await fetch(`${base}/api/bad/x`, { headers: { 'x-api-key': 'bad-key' } });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_gateway');
  });

  it('exposes Prometheus metrics including request and 429 counters', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('gateway_http_requests_total');
    expect(text).toMatch(/gateway_http_requests_total\{route="fw",method="GET",status="200"\} \d+/);
    expect(text).toMatch(/gateway_rate_limited_total\{route="fw",algorithm="fixed-window"\} \d+/);
    expect(text).toContain('gateway_http_request_duration_seconds_bucket');
    expect(text).toMatch(/gateway_upstream_errors_total\{route="bad"\} \d+/);
  });

  it('reports health', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; store: string };
    expect(body.status).toBe('ok');
    expect(body.store).toBe('memory');
  });
});
