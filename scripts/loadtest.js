/**
 * k6 load test for the gateway (requires k6: https://k6.io).
 *
 * Run:
 *   k6 run scripts/loadtest.js
 *   k6 run -e GATEWAY_URL=http://127.0.0.1:8080 scripts/loadtest.js
 *
 * Each virtual user carries its own API key, so you can observe per-key
 * isolation: raising VUs raises total throughput until each key hits its
 * own limit.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.GATEWAY_URL || 'http://127.0.0.1:8080';

const allowed = new Counter('gateway_allowed');
const limited = new Counter('gateway_limited');

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
    },
  },
  thresholds: {
    // Every response should be either allowed (200) or correctly limited (429).
    checks: ['rate>0.99'],
  },
};

const routes = ['/api/fixed/demo', '/api/token/demo', '/api/sliding/demo'];

export default function () {
  const route = routes[Math.floor(Math.random() * routes.length)];
  const res = http.get(`${BASE}${route}`, {
    headers: { 'x-api-key': `k6-vu-${__VU}` },
  });

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'rate limit headers present': (r) =>
      r.headers['X-Ratelimit-Limit'] !== undefined || r.headers['X-RateLimit-Limit'] !== undefined,
    '429 carries Retry-After': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });

  if (res.status === 200) allowed.add(1);
  if (res.status === 429) limited.add(1);

  sleep(0.1);
}
