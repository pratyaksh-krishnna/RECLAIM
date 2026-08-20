import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export function makeRedis(): Redis {
  // BullMQ requires maxRetriesPerRequest: null
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
