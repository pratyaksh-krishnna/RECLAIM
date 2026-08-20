import { auditEvents } from '../db/schema.js';
import type { Tx } from '../db/client.js';

export interface AuditWrite {
  caseId?: string | null;
  actorType: 'system' | 'agent' | 'human' | 'provider';
  actorId?: string | null;
  eventType: string;
  payload: unknown;
}

/** Append-only audit write; must be called inside the same tx as the change it records. */
export async function writeAudit(tx: Tx, entry: AuditWrite): Promise<void> {
  await tx.insert(auditEvents).values({
    caseId: entry.caseId ?? null,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    eventType: entry.eventType,
    payload: entry.payload as object,
  });
}
