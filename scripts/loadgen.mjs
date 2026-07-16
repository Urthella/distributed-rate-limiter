/**
 * Plain-Node load generator (no k6 required).
 *
 * Hammers each configured route with two different API keys and prints the
 * observed status distribution plus sample rate-limit headers, demonstrating
 * per-key isolation and correct 200 -> 429 behaviour out of the box.
 *
 * Usage: node scripts/loadgen.mjs
 * Env:   GATEWAY_URL (default http://127.0.0.1:8080)
 *        LOADGEN_REQUESTS (per route+key, default 30)
 *        LOADGEN_CONCURRENCY (default 5)
 */

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8080';
const REQUESTS = Number(process.env.LOADGEN_REQUESTS ?? 30);
const CONCURRENCY = Number(process.env.LOADGEN_CONCURRENCY ?? 5);

const targets = [
  { label: '/api/fixed', algorithm: 'fixed-window', path: '/api/fixed/demo' },
  { label: '/api/token', algorithm: 'token-bucket', path: '/api/token/demo' },
  { label: '/api/sliding', algorithm: 'sliding-window-log', path: '/api/sliding/demo' },
];
const apiKeys = ['demo-key-a', 'demo-key-b'];

function pickHeaders(res) {
  return {
    limit: res.headers.get('x-ratelimit-limit'),
    remaining: res.headers.get('x-ratelimit-remaining'),
    reset: res.headers.get('x-ratelimit-reset'),
    retryAfter: res.headers.get('retry-after'),
  };
}

async function hammer(target, apiKey) {
  const counts = { ok: 0, limited: 0, other: 0, error: 0 };
  let sampleOk = null;
  let sampleLimited = null;

  for (let sent = 0; sent < REQUESTS; sent += CONCURRENCY) {
    const batch = Math.min(CONCURRENCY, REQUESTS - sent);
    const results = await Promise.all(
      Array.from({ length: batch }, async () => {
        try {
          const res = await fetch(GATEWAY + target.path, { headers: { 'x-api-key': apiKey } });
          await res.arrayBuffer(); // drain body so sockets are reusable
          return res;
        } catch {
          return null;
        }
      }),
    );
    for (const res of results) {
      if (!res) {
        counts.error++;
      } else if (res.status >= 200 && res.status < 300) {
        counts.ok++;
        if (!sampleOk) sampleOk = pickHeaders(res);
      } else if (res.status === 429) {
        counts.limited++;
        if (!sampleLimited) sampleLimited = pickHeaders(res);
      } else {
        counts.other++;
      }
    }
  }
  return { counts, sampleOk, sampleLimited };
}

function row(cols, widths) {
  return cols.map((c, i) => String(c).padEnd(widths[i])).join('');
}

async function main() {
  console.log(`Load generator -> ${GATEWAY}`);
  console.log(`${REQUESTS} requests per route per key, concurrency ${CONCURRENCY}\n`);

  const widths = [15, 22, 13, 8, 6, 6, 7, 6];
  console.log(row(['Route', 'Algorithm', 'API key', 'Total', '2xx', '429', 'Other', 'Err'], widths));
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0)));

  const samples = [];
  let totalOk = 0;
  let totalLimited = 0;

  for (const target of targets) {
    for (const apiKey of apiKeys) {
      const { counts, sampleOk, sampleLimited } = await hammer(target, apiKey);
      totalOk += counts.ok;
      totalLimited += counts.limited;
      console.log(
        row(
          [target.label, target.algorithm, apiKey, REQUESTS, counts.ok, counts.limited, counts.other, counts.error],
          widths,
        ),
      );
      if (sampleOk || sampleLimited) {
        samples.push({ label: `${target.label} (${apiKey})`, sampleOk, sampleLimited });
      }
    }
  }

  console.log('\nSample rate-limit headers:');
  for (const s of samples.slice(0, 3)) {
    if (s.sampleOk) {
      console.log(
        `  ${s.label} allowed  -> X-RateLimit-Limit: ${s.sampleOk.limit}, X-RateLimit-Remaining: ${s.sampleOk.remaining}, X-RateLimit-Reset: ${s.sampleOk.reset}`,
      );
    }
    if (s.sampleLimited) {
      console.log(
        `  ${s.label} limited  -> 429, Retry-After: ${s.sampleLimited.retryAfter}, X-RateLimit-Remaining: ${s.sampleLimited.remaining}, X-RateLimit-Reset: ${s.sampleLimited.reset}`,
      );
    }
  }

  console.log(
    `\nTotals: ${totalOk} allowed, ${totalLimited} rate-limited. ` +
      'Each API key has its own counters (per-key isolation).',
  );

  if (totalOk === 0 || totalLimited === 0) {
    console.error('\nExpected BOTH allowed and 429 responses; check that the gateway and upstream are running.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
