import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export const sql = postgres(env.DATABASE_URL, { max: 10 });
export const db = drizzle(sql, { schema });
export type Db = typeof db;
/** Transaction handle type used by everything that must be atomic. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
