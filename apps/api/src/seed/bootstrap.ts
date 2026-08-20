import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { templates, users } from '../db/schema.js';
import { hashPassword } from '../auth/auth.js';
import { TEMPLATE_REGISTRY } from '../templates/registry.js';
import { ensureSeedPolicy } from '../policy/service.js';
import { env } from '../config/env.js';

/** Idempotent boot seed: policy v1, template registry, demo users. */
export async function bootstrap(db: Db): Promise<void> {
  await ensureSeedPolicy(db);
  for (const skeleton of Object.values(TEMPLATE_REGISTRY)) {
    await db
      .insert(templates)
      .values({ id: skeleton.templateId, skeleton, active: true })
      .onConflictDoUpdate({ target: templates.id, set: { skeleton } });
  }
  // Demo accounts exist ONLY outside production — never a production backdoor.
  if (env.NODE_ENV === 'production') return;
  const demoUsers = [
    { email: 'admin@reclaim.test', name: 'Asha Admin', role: 'admin' as const },
    { email: 'operator@reclaim.test', name: 'Om Operator', role: 'operator' as const },
    { email: 'viewer@reclaim.test', name: 'Vi Viewer', role: 'viewer' as const },
  ];
  for (const u of demoUsers) {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, u.email)).limit(1);
    if (!existing) {
      await db.insert(users).values({ ...u, passwordHash: hashPassword('reclaim-demo') });
    }
  }
}
