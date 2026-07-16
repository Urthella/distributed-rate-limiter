import { readFileSync } from 'node:fs';
import type { GatewayConfig, RateLimitParams, RouteConfig } from './types';

const ALGORITHMS = new Set(['fixed-window', 'token-bucket', 'sliding-window-log']);

function fail(msg: string): never {
  throw new Error(`Invalid gateway config: ${msg}`);
}

function assertPositiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${name} must be a positive number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertPositiveInt(value: unknown, name: string): number {
  assertPositiveNumber(value, name);
  if (!Number.isInteger(value)) fail(`${name} must be an integer (got ${JSON.stringify(value)})`);
  return value as number;
}

function validateRateLimit(raw: unknown, where: string): RateLimitParams {
  if (!raw || typeof raw !== 'object') fail(`${where}.rateLimit must be an object`);
  const rl = raw as Record<string, unknown>;
  if (typeof rl.algorithm !== 'string' || !ALGORITHMS.has(rl.algorithm)) {
    fail(`${where}.rateLimit.algorithm must be one of ${[...ALGORITHMS].join(', ')}`);
  }
  if (rl.algorithm === 'token-bucket') {
    return {
      algorithm: 'token-bucket',
      capacity: assertPositiveInt(rl.capacity, `${where}.rateLimit.capacity`),
      refillPerSecond: assertPositiveNumber(rl.refillPerSecond, `${where}.rateLimit.refillPerSecond`),
    };
  }
  return {
    algorithm: rl.algorithm as 'fixed-window' | 'sliding-window-log',
    limit: assertPositiveInt(rl.limit, `${where}.rateLimit.limit`),
    windowSeconds: assertPositiveNumber(rl.windowSeconds, `${where}.rateLimit.windowSeconds`),
  };
}

function validateRoute(raw: unknown, index: number): RouteConfig {
  const where = `routes[${index}]`;
  if (!raw || typeof raw !== 'object') fail(`${where} must be an object`);
  const r = raw as Record<string, unknown>;
  if (typeof r.pathPrefix !== 'string' || !r.pathPrefix.startsWith('/')) {
    fail(`${where}.pathPrefix must be a string starting with "/"`);
  }
  if (typeof r.upstream !== 'string') fail(`${where}.upstream must be a string URL`);
  let url: URL;
  try {
    url = new URL(r.upstream);
  } catch {
    fail(`${where}.upstream is not a valid URL: ${r.upstream}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${where}.upstream must be http(s), got ${url.protocol}`);
  }
  const route: RouteConfig = {
    pathPrefix: r.pathPrefix,
    upstream: r.upstream,
    rateLimit: validateRateLimit(r.rateLimit, where),
  };
  if (r.id !== undefined) {
    if (typeof r.id !== 'string' || r.id.length === 0) fail(`${where}.id must be a non-empty string`);
    route.id = r.id;
  }
  if (r.stripPrefix !== undefined) {
    if (typeof r.stripPrefix !== 'boolean') fail(`${where}.stripPrefix must be a boolean`);
    route.stripPrefix = r.stripPrefix;
  }
  if (r.timeoutMs !== undefined) route.timeoutMs = assertPositiveNumber(r.timeoutMs, `${where}.timeoutMs`);
  if (r.keyOverrides !== undefined) {
    if (!r.keyOverrides || typeof r.keyOverrides !== 'object' || Array.isArray(r.keyOverrides)) {
      fail(`${where}.keyOverrides must be an object`);
    }
    const overrides: RouteConfig['keyOverrides'] = {};
    for (const [key, ov] of Object.entries(r.keyOverrides as Record<string, unknown>)) {
      if (!ov || typeof ov !== 'object') fail(`${where}.keyOverrides["${key}"] must be an object`);
      const o = ov as Record<string, unknown>;
      overrides[key] = {};
      if (o.limit !== undefined) overrides[key].limit = assertPositiveInt(o.limit, `${where}.keyOverrides["${key}"].limit`);
      if (o.windowSeconds !== undefined) overrides[key].windowSeconds = assertPositiveNumber(o.windowSeconds, `${where}.keyOverrides["${key}"].windowSeconds`);
      if (o.capacity !== undefined) overrides[key].capacity = assertPositiveInt(o.capacity, `${where}.keyOverrides["${key}"].capacity`);
      if (o.refillPerSecond !== undefined) overrides[key].refillPerSecond = assertPositiveNumber(o.refillPerSecond, `${where}.keyOverrides["${key}"].refillPerSecond`);
    }
    route.keyOverrides = overrides;
  }
  return route;
}

export function validateConfig(raw: unknown): GatewayConfig {
  if (!raw || typeof raw !== 'object') fail('config must be a JSON object');
  const cfg = raw as Record<string, unknown>;
  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) {
    fail('routes must be a non-empty array');
  }
  const routes = cfg.routes.map(validateRoute);
  const seen = new Set<string>();
  for (const r of routes) {
    if (seen.has(r.pathPrefix)) fail(`duplicate pathPrefix "${r.pathPrefix}"`);
    seen.add(r.pathPrefix);
  }
  const config: GatewayConfig = { routes };
  if (cfg.listen !== undefined) {
    if (!cfg.listen || typeof cfg.listen !== 'object') fail('listen must be an object');
    const listen = cfg.listen as Record<string, unknown>;
    config.listen = {};
    if (listen.port !== undefined) config.listen.port = assertPositiveInt(listen.port, 'listen.port');
    if (listen.host !== undefined) {
      if (typeof listen.host !== 'string') fail('listen.host must be a string');
      config.listen.host = listen.host;
    }
  }
  if (cfg.trustProxy !== undefined) {
    if (typeof cfg.trustProxy !== 'boolean') fail('trustProxy must be a boolean');
    config.trustProxy = cfg.trustProxy;
  }
  return config;
}

export function loadConfig(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read gateway config at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gateway config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return validateConfig(parsed);
}
