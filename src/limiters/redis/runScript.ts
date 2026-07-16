import { createHash } from 'node:crypto';

/**
 * Minimal structural interface satisfied by an ioredis client (and by the
 * in-process fake used in tests).
 */
export interface RedisScriptRunner {
  evalsha(sha: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
}

const shaCache = new Map<string, string>();

export function scriptSha1(script: string): string {
  let sha = shaCache.get(script);
  if (!sha) {
    sha = createHash('sha1').update(script).digest('hex');
    shaCache.set(script, sha);
  }
  return sha;
}

function isNoScript(err: unknown): boolean {
  return err instanceof Error && err.message.includes('NOSCRIPT');
}

/**
 * Run a Lua script with EVALSHA, falling back to EVAL (which also loads the
 * script into the server cache) when the server does not know the SHA yet —
 * e.g. first call, after a Redis restart, or after SCRIPT FLUSH.
 */
export async function runScript(
  client: RedisScriptRunner,
  script: string,
  keys: string[],
  args: (string | number)[],
): Promise<unknown> {
  const sha = scriptSha1(script);
  try {
    return await client.evalsha(sha, keys.length, ...keys, ...args);
  } catch (err) {
    if (isNoScript(err)) {
      return client.eval(script, keys.length, ...keys, ...args);
    }
    throw err;
  }
}
