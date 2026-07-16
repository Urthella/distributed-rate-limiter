/**
 * One-command demo: starts the bundled demo upstream + the gateway (using
 * config/gateway.json), runs the plain-Node load generator against all three
 * algorithm routes, prints the summary and tears everything down.
 *
 * Usage: npm run demo
 * Env:   PORT (gateway, default 8080), UPSTREAM_PORT (default 9100)
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 9100);
const GATEWAY_PORT = Number(process.env.PORT ?? 8080);

const children = [];

function start(name, scriptPath, env) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[demo] ${name} exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function killAll() {
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
  }
}
process.on('exit', killAll);
process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});

async function waitFor(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
    } catch {
      /* not up yet */
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  console.log('[demo] starting demo upstream...');
  start('upstream', path.join(root, 'dist', 'demo-upstream.js'), {
    UPSTREAM_PORT: String(UPSTREAM_PORT),
  });
  await waitFor(`http://127.0.0.1:${UPSTREAM_PORT}/ping`);

  console.log('[demo] starting gateway...');
  start('gateway', path.join(root, 'dist', 'index.js'), {
    PORT: String(GATEWAY_PORT),
    CONFIG_PATH: path.join(root, 'config', 'gateway.json'),
  });
  await waitFor(`http://127.0.0.1:${GATEWAY_PORT}/healthz`);

  console.log('\n[demo] --- running load generator ---\n');
  const load = start('loadgen', path.join(root, 'scripts', 'loadgen.mjs'), {
    GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
  });
  const exitCode = await new Promise((resolve) => load.on('exit', resolve));

  console.log(`\n[demo] metrics preview from http://127.0.0.1:${GATEWAY_PORT}/metrics :`);
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/metrics`);
    const text = await res.text();
    const interesting = text
      .split('\n')
      .filter((l) => l.startsWith('gateway_http_requests_total') || l.startsWith('gateway_rate_limited_total'))
      .slice(0, 12);
    for (const line of interesting) console.log(`  ${line}`);
  } catch (err) {
    console.error(`[demo] could not fetch metrics: ${err.message}`);
  }

  if (exitCode !== 0) throw new Error(`load generator exited with code ${exitCode}`);
  console.log('\n[demo] demo complete.');
}

main()
  .then(() => {
    killAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[demo] ${err.message}`);
    killAll();
    process.exit(1);
  });
