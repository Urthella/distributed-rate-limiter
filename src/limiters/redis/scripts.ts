/**
 * Atomic Lua scripts for the Redis-backed limiters.
 *
 * Why Lua? A naive GET -> compute -> SET round-trip from the gateway is a
 * read-modify-write race: two gateway replicas can both read count=9,
 * both decide "under the limit of 10", and both allow — the client got 11.
 * Redis executes an EVAL script atomically (single-threaded, no interleaving),
 * so check-and-increment is one indivisible operation across every instance.
 *
 * Why redis.call('TIME')? All time arithmetic uses the *Redis server's* clock,
 * never the gateway's. With N gateway replicas whose clocks drift apart, using
 * local time would make windows disagree between replicas; a single shared
 * clock source removes the problem entirely. (Scripts that call TIME and then
 * write require effect-based replication — the default since Redis 5.)
 */

export const FIXED_WINDOW_SCRIPT = `
local time = redis.call('TIME')
local now_ms = time[1] * 1000 + math.floor(time[2] / 1000)
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local window_id = math.floor(now_ms / window_ms)
local key = KEYS[1] .. ':' .. window_id
local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, window_ms + 1000)
end
local remaining = limit - count
if remaining < 0 then remaining = 0 end
local allowed = 0
if count <= limit then allowed = 1 end
local reset_ms = (window_id + 1) * window_ms
return {allowed, remaining, reset_ms, now_ms}
`;

export const TOKEN_BUCKET_SCRIPT = `
local time = redis.call('TIME')
local now_ms = time[1] * 1000 + math.floor(time[2] / 1000)
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now_ms
end
local elapsed_ms = now_ms - ts
if elapsed_ms < 0 then elapsed_ms = 0 end
tokens = tokens + (elapsed_ms * refill_per_sec / 1000)
if tokens > capacity then tokens = capacity end
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now_ms))
local ttl_ms = math.ceil((capacity / refill_per_sec) * 1000) + 60000
redis.call('PEXPIRE', KEYS[1], ttl_ms)
local retry_ms = 0
if allowed == 0 then
  retry_ms = math.ceil(((1 - tokens) / refill_per_sec) * 1000)
end
local full_ms = math.ceil(((capacity - tokens) / refill_per_sec) * 1000)
return {allowed, math.floor(tokens), now_ms + full_ms, retry_ms, now_ms}
`;

export const SLIDING_WINDOW_SCRIPT = `
local time = redis.call('TIME')
local now_ms = time[1] * 1000 + math.floor(time[2] / 1000)
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now_ms - window_ms)
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now_ms, now_ms .. '-' .. member)
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', KEYS[1], window_ms + 1000)
local remaining = limit - count
if remaining < 0 then remaining = 0 end
local reset_ms = now_ms + window_ms
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then
  reset_ms = tonumber(oldest[2]) + window_ms
end
return {allowed, remaining, reset_ms, now_ms}
`;
