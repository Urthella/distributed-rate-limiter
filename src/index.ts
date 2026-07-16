import path from 'node:path';
import { loadConfig } from './config';
import { startGateway } from './gateway';

async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? path.join(process.cwd(), 'config', 'gateway.json');
  const config = loadConfig(configPath);
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;

  const gateway = await startGateway(config, { port });
  console.log(`[gateway] listening on :${gateway.port} (rate-limit store: ${gateway.storeKind})`);
  for (const route of config.routes) {
    const rl = route.rateLimit;
    const desc =
      rl.algorithm === 'token-bucket'
        ? `capacity=${rl.capacity} refill=${rl.refillPerSecond}/s`
        : `limit=${rl.limit}/${rl.windowSeconds}s`;
    console.log(`[gateway] route ${route.pathPrefix} -> ${route.upstream} [${rl.algorithm} ${desc}]`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[gateway] received ${signal}, shutting down`);
    await gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error(`[gateway] fatal: ${err.message}`);
  process.exit(1);
});
