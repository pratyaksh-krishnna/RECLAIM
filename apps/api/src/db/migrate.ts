import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './client.js';

await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
console.log('migrations applied');
await sql.end();
