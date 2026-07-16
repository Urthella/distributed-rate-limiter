import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteConfig } from './types';

/** Hop-by-hop headers must not be forwarded (RFC 7230 section 6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyHooks {
  onUpstreamError?: (err: Error) => void;
}

/**
 * Reverse-proxy a single request to the route's upstream.
 * Preserves method, headers (minus hop-by-hop) and streams the body both ways.
 * Upstream failures produce a 502 (unless headers were already sent).
 */
export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: RouteConfig,
  hooks: ProxyHooks = {},
): void {
  const upstreamUrl = new URL(route.upstream);
  const rawUrl = req.url ?? '/';

  let targetPath = route.stripPrefix ? rawUrl.slice(route.pathPrefix.length) : rawUrl;
  if (targetPath === '') targetPath = '/';
  if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;
  const basePath = upstreamUrl.pathname === '/' ? '' : upstreamUrl.pathname.replace(/\/+$/, '');
  const forwardPath = basePath + targetPath;

  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  headers['host'] = upstreamUrl.host;
  const remote = req.socket.remoteAddress ?? '';
  const priorXff = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = priorXff
    ? `${Array.isArray(priorXff) ? priorXff.join(', ') : priorXff}, ${remote}`
    : remote;
  headers['x-forwarded-proto'] = 'http';
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;

  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  const timeoutMs = route.timeoutMs ?? 10_000;

  const proxyReq = transport.request(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
      path: forwardPath,
      method: req.method,
      headers,
      timeout: timeoutMs,
    },
    (proxyRes) => {
      const outHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        outHeaders[name] = value;
      }
      // Rate-limit headers were applied via res.setHeader() and are merged in.
      res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error(`upstream timeout after ${timeoutMs}ms`));
  });

  proxyReq.on('error', (err) => {
    hooks.onUpstreamError?.(err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_gateway', message: `Upstream request failed: ${err.message}` }));
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
}
