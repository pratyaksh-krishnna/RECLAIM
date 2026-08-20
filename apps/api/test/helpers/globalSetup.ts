import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

export default async function setup(): Promise<void> {
  const admin = postgres('postgres://reclaim:reclaim@localhost:5433/reclaim', { max: 1 });
  const exists = await admin`SELECT 1 FROM pg_database WHERE datname = 'reclaim_test'`;
  if (exists.length === 0) await admin.unsafe('CREATE DATABASE reclaim_test');
  await admin.end();

  const test = postgres('postgres://reclaim:reclaim@localhost:5433/reclaim_test', { max: 1 });
  await test.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const db = drizzle(test);
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  await test.end();
}
