import http from 'node:http';

/**
 * Tiny demo upstream so the whole gateway demo runs locally with zero
 * external services. Echoes request details as JSON for any method/path.
 */
const port = Number(process.env.UPSTREAM_PORT ?? 9100);

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        service: 'demo-upstream',
        method: req.method,
        path: req.url,
        apiKey: req.headers['x-api-key'] ?? null,
        forwardedFor: req.headers['x-forwarded-for'] ?? null,
        forwardedHost: req.headers['x-forwarded-host'] ?? null,
        bodyBytes: body.length,
        at: new Date().toISOString(),
      }),
    );
  });
});

server.listen(port, () => {
  console.log(`[upstream] demo upstream listening on :${port}`);
});
