import { Link, createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, formatINR, getUser, timeAgo } from '../lib/api';
import type { HumanQueueItem } from '../lib/types';
import { Badge, Button, CAUSE_LABELS, Card, CardContent } from '../components/ui/primitives';

export const Route = createFileRoute('/approvals')({ component: Approvals });

const EMPTY_QUEUE: HumanQueueItem[] = [];

function Approvals() {
  const { data = EMPTY_QUEUE } = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api<HumanQueueItem[]>('/approvals'),
  });
  const canAct = getUser()?.role !== 'viewer';

  const approvals = data.filter((d) => d.kind === 'approval');
  const escalations = data.filter((d) => d.kind === 'escalation');
  const disputes = data.filter((d) => d.kind === 'dispute');
  const isAdmin = getUser()?.role === 'admin';

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight">Human inbox</h1>
        {approvals.length > 0 && <Badge tone="amber">{approvals.length} awaiting approval</Badge>}
        {escalations.length > 0 && <Badge tone="red">{escalations.length} escalated to you</Badge>}
        {disputes.length > 0 && <Badge tone="violet">{disputes.length} disputed — outreach frozen</Badge>}
      </div>

      {data.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-muted">Nothing needs a human right now.</CardContent>
        </Card>
      )}

      {disputes.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold tracking-tight text-muted uppercase">
            <Lock size={13} className="text-purple-700" />
            Disputed — all outreach frozen until a human resolves it
          </h2>
          <div className="space-y-3">
            {disputes.map((row) => (
              <DisputeCard key={row.caseRow.id} row={row} isAdmin={isAdmin} />
            ))}
          </div>
        </section>
      )}

      {escalations.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold tracking-tight text-muted uppercase">
            <AlertTriangle size={13} className="text-bad" />
            Escalated — the pipeline stopped and needs your decision
          </h2>
          <div className="space-y-3">
            {escalations.map((row) => (
              <EscalationCard key={row.caseRow.id} row={row} canAct={canAct} />
            ))}
          </div>
        </section>
      )}

      {approvals.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold tracking-tight text-muted uppercase">
            <ShieldCheck size={13} className="text-accent" />
            Proposed actions awaiting approval
          </h2>
          <div className="space-y-3">
            {approvals.map((row) => (
              <ApprovalCard key={row.intervention!.id} row={row} canAct={canAct} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ---------------- approval: one proposed action, yes or no ---------------- */

function ApprovalCard({ row, canAct }: { row: HumanQueueItem; canAct: boolean }) {
  const qc = useQueryClient();
  const iv = row.intervention!;
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      api(`/recovery/cases/${row.caseRow.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ interventionId: iv.id, decision }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['revenue-risk-nav'] });
    },
  });

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 pt-4">
        <CaseIdentity row={row} />
        <div className="font-semibold tabular-nums">{formatINR(row.caseRow.exposurePaise)}</div>
        <code className="rounded bg-black/5 px-1.5 py-0.5 text-xs">{iv.actionType}</code>
        <PromiseDetail actionType={iv.actionType} params={iv.params} />
        {iv.confidence && <Badge tone="blue">{Math.round(Number(iv.confidence) * 100)}% conf</Badge>}
        <span className="max-w-md text-sm text-muted">{iv.rationale}</span>
        <span className="text-xs text-muted">{timeAgo(iv.createdAt)}</span>
        {canAct && (
          <div className="ml-auto flex gap-2">
            <Button variant="success" size="sm" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              Approve
            </Button>
            <Button variant="outline" size="sm" disabled={decide.isPending} onClick={() => decide.mutate('deny')}>
              Deny
            </Button>
          </div>
        )}
        <MutationError error={decide.error} />
      </CardContent>
    </Card>
  );
}

/* ---------------- dispute: a compliance freeze only a human lifts ---------------- */

/**
 * Resolving a dispute is the most sensitive control here: "rejected" resumes
 * collection against someone who formally contested a charge. Admin-only,
 * requires a written reason, and both outcomes are audited with the actor.
 */
function DisputeCard({ row, isAdmin }: { row: HumanQueueItem; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<'upheld' | 'rejected' | null>(null);
  const [reason, setReason] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      api(`/recovery/cases/${row.caseRow.id}/resolve-dispute`, {
        method: 'POST',
        body: JSON.stringify({ outcome, reason }),
      }),
    onSuccess: () => {
      setOutcome(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['revenue-risk-nav'] });
    },
  });

  return (
    <Card className="border-purple-600/30">
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <CaseIdentity row={row} />
          <div className="font-semibold tabular-nums">{formatINR(row.caseRow.exposurePaise)}</div>
          <Badge tone="violet">
            <Lock size={10} className="mr-1" />
            outreach frozen
          </Badge>
          {row.escalationReason && <span className="text-sm text-muted">{row.escalationReason}</span>}
          {isAdmin && !outcome && (
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setOutcome('rejected')}>
                Dispute rejected — resume recovery
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setOutcome('upheld')}>
                Dispute upheld — write it off
              </Button>
            </div>
          )}
          {!isAdmin && <span className="ml-auto text-xs text-muted">Only an admin can resolve a dispute.</span>}
        </div>

        {row.summary && (
          <p className="mt-3 rounded-md border border-border bg-surface p-3 text-sm whitespace-pre-wrap">
            {row.summary}
          </p>
        )}

        {outcome && (
          <div className="mt-3 space-y-2 rounded-md border border-border bg-surface p-3">
            <p className="text-sm font-medium">
              {outcome === 'rejected'
                ? 'Resuming collection on a formally disputed charge. This is recorded against your account.'
                : 'Closing this case as uncollectable. No further outreach.'}
            </p>
            <TextInput
              value={reason}
              onChange={setReason}
              placeholder="Why? (recorded in the audit trail, min 10 characters)"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={outcome === 'rejected' ? 'default' : 'destructive'}
                disabled={reason.trim().length < 10 || submit.isPending}
                onClick={() => submit.mutate()}
              >
                Confirm — dispute {outcome}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setOutcome(null)}>
                Cancel
              </Button>
            </div>
            <MutationError error={submit.error} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------- escalation: no action proposed, the human decides ------------- */

function EscalationCard({ row, canAct }: { row: HumanQueueItem; canAct: boolean }) {
  const qc = useQueryClient();
  const [composing, setComposing] = useState(false);
  // a holdout case is policy-locked: any proposal would be denied and execute
  // nothing, so offer stop only rather than a button that silently does nothing
  const locked = row.caseRow.holdoutArm === 'holdout';
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    void qc.invalidateQueries({ queryKey: ['revenue-risk-nav'] });
  };

  const stop = useMutation({
    mutationFn: (reason: string) =>
      api(`/recovery/cases/${row.caseRow.id}/stop`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: refresh,
  });
  const reanalyze = useMutation({
    mutationFn: () => api(`/recovery/cases/${row.caseRow.id}/analyze`, { method: 'POST', body: '{}' }),
    onSuccess: refresh,
  });

  return (
    <Card className="border-bad/30">
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <CaseIdentity row={row} />
          <div className="font-semibold tabular-nums">{formatINR(row.caseRow.exposurePaise)}</div>
          {row.escalationReason && <Badge tone="red">{row.escalationReason}</Badge>}
          {locked && <Badge tone="violet">holdout — action-locked</Badge>}
          {canAct && (
            <div className="ml-auto flex gap-2">
              {!locked && (
                <>
                  <Button variant="default" size="sm" onClick={() => setComposing((v) => !v)}>
                    {composing ? 'Cancel' : 'Decide what to do'}
                  </Button>
                  <Button variant="outline" size="sm" disabled={reanalyze.isPending} onClick={() => reanalyze.mutate()}>
                    Send back to agents
                  </Button>
                </>
              )}
              <Button
                variant="destructive"
                size="sm"
                disabled={stop.isPending}
                onClick={() => stop.mutate('human_request')}
              >
                Do nothing — stop
              </Button>
            </div>
          )}
        </div>

        {row.summary && (
          <p className="mt-3 rounded-md border border-border bg-surface p-3 text-sm whitespace-pre-wrap">
            {row.summary}
          </p>
        )}

        <MutationError error={stop.error ?? reanalyze.error} />

        {composing && canAct && !locked && (
          <ActionComposer
            caseId={row.caseRow.id}
            onDone={() => {
              setComposing(false);
              refresh();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

/* ----------------------------- action composer ----------------------------- */

/**
 * Human proposals go through `POST /intervene`, which walks the case back to
 * `planned` so the SAME deterministic policy gate evaluates them. A human can
 * choose the action; a human still cannot bypass policy, and no action here
 * carries a monetary amount — the server resolves amounts from the invoice.
 *
 * `escalate_to_human` is omitted (the case is already escalated) and
 * `stop_workflow` is omitted in favour of the dedicated Stop button.
 */
const COMPOSABLE = [
  { type: 'create_payment_link', label: 'Send an exact-amount payment link' },
  { type: 'send_email', label: 'Email the customer' },
  { type: 'schedule_reminder', label: 'Schedule a reminder' },
  { type: 'mark_wait', label: 'Wait for something' },
  { type: 'record_promise_to_pay', label: 'Record a promise to pay' },
  { type: 'schedule_mandate_reexecution', label: 'Re-execute the mandate' },
] as const;

type ComposableType = (typeof COMPOSABLE)[number]['type'];

/**
 * Only the templates `send_email` can actually render. `payment_link_delivery`
 * needs a {{payment_link}} and `pre_debit_notice` needs {{customer_name}} +
 * {{debit_date}} — immutable slots the send_email path never supplies, because
 * those templates are the deterministic message halves of `create_payment_link`
 * and `schedule_mandate_reexecution`, which inject those values themselves.
 * Offering them here would let one click strand a case in `escalated` with
 * "missing immutable slot value …" — an engineering error dressed as a
 * decision, which is the exact thing the Human Inbox exists to stop showing.
 */
const TEMPLATES = ['payment_failed_notice', 'payment_reminder'] as const;

function ActionComposer({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const [type, setType] = useState<ComposableType>('create_payment_link');
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  const propose = useMutation({
    mutationFn: (action: Record<string, unknown>) =>
      api(`/recovery/cases/${caseId}/intervene`, { method: 'POST', body: JSON.stringify({ action }) }),
    onSuccess: onDone,
  });

  const iso = (v: string | undefined) => (v ? new Date(v).toISOString() : '');
  const action = (): Record<string, unknown> => {
    switch (type) {
      case 'create_payment_link':
        return { type };
      case 'send_email':
        return {
          type,
          templateId: f.templateId ?? 'payment_reminder',
          language: f.language ?? 'en',
          toneRegister: f.toneRegister ?? 'friendly',
          slotFills: {},
        };
      case 'schedule_reminder':
        return { type, remindAt: iso(f.remindAt), note: f.note ?? '' };
      case 'mark_wait':
        return { type, waitUntil: iso(f.waitUntil), waitingFor: f.waitingFor ?? '' };
      case 'record_promise_to_pay':
        return { type, promisedDate: iso(f.promisedDate), amountReference: f.amountReference || null };
      case 'schedule_mandate_reexecution':
        return { type, scheduleAt: iso(f.scheduleAt) };
    }
  };

  const needsDate: Partial<Record<ComposableType, string>> = {
    schedule_reminder: 'remindAt',
    mark_wait: 'waitUntil',
    record_promise_to_pay: 'promisedDate',
    schedule_mandate_reexecution: 'scheduleAt',
  };
  const dateField = needsDate[type];
  const incomplete = dateField ? !f[dateField] : false;

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-muted">Action</label>
        <Select value={type} onChange={(v) => { setType(v as ComposableType); setF({}); }}>
          {COMPOSABLE.map((a) => (
            <option key={a.type} value={a.type}>
              {a.label}
            </option>
          ))}
        </Select>
      </div>

      {type === 'send_email' && (
        <div className="flex flex-wrap gap-2">
          <Field label="Template">
            <Select value={f.templateId ?? 'payment_reminder'} onChange={(v) => set('templateId', v)}>
              {TEMPLATES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Language">
            <Select value={f.language ?? 'en'} onChange={(v) => set('language', v)}>
              <option value="en">en</option>
              <option value="hi">hi</option>
              <option value="hinglish">hinglish</option>
            </Select>
          </Field>
          <Field label="Tone">
            <Select value={f.toneRegister ?? 'friendly'} onChange={(v) => set('toneRegister', v)}>
              <option value="formal">formal</option>
              <option value="friendly">friendly</option>
              <option value="firm">firm</option>
            </Select>
          </Field>
        </div>
      )}

      {dateField && (
        <Field label={type === 'record_promise_to_pay' ? 'Promised date' : 'When'}>
          <input
            type="datetime-local"
            className="h-8 rounded-md border border-border bg-white px-2 text-sm"
            value={f[dateField] ?? ''}
            onChange={(e) => set(dateField, e.target.value)}
          />
        </Field>
      )}

      {type === 'schedule_reminder' && (
        <Field label="Note">
          <TextInput value={f.note ?? ''} onChange={(v) => set('note', v)} placeholder="why this reminder" />
        </Field>
      )}
      {type === 'mark_wait' && (
        <Field label="Waiting for">
          <TextInput value={f.waitingFor ?? ''} onChange={(v) => set('waitingFor', v)} placeholder="what we expect" />
        </Field>
      )}
      {type === 'record_promise_to_pay' && (
        <Field label="Amount reference">
          <TextInput
            value={f.amountReference ?? ''}
            onChange={(v) => set('amountReference', v)}
            placeholder="e.g. the full amount — never a number the server acts on"
          />
        </Field>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={propose.isPending || incomplete} onClick={() => propose.mutate(action())}>
          Propose — policy gate still applies
        </Button>
        <span className="text-xs text-muted">
          The deterministic policy engine evaluates this before anything is sent.
        </span>
      </div>
      <MutationError error={propose.error} />
    </div>
  );
}

/* -------------------------------- fragments -------------------------------- */

function CaseIdentity({ row }: { row: HumanQueueItem }) {
  return (
    <div className="min-w-48">
      <Link to="/cases/$caseId" params={{ caseId: row.caseRow.id }} className="font-medium hover:underline">
        {row.customerName}
      </Link>
      <div className="text-xs text-muted">
        {row.caseRow.causeHypothesis
          ? (CAUSE_LABELS[row.caseRow.causeHypothesis] ?? row.caseRow.causeHypothesis)
          : 'undiagnosed'}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted">{label}</label>
      {children}
    </div>
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select
      className="h-8 rounded-md border border-border bg-white px-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className="h-8 w-96 max-w-full rounded-md border border-border bg-white px-2 text-sm"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? `${error.status}: ${error.message}` : String(error);
  return <p className="mt-2 text-xs text-bad">{message}</p>;
}

/**
 * Accepting a promise pauses collection until the promised date, so the
 * operator must see the date and how far out it is before saying yes — the
 * agent read it out of free text the customer wrote.
 */
function PromiseDetail({ actionType, params }: { actionType: string; params: unknown }) {
  if (actionType !== 'record_promise_to_pay') return null;
  const p = params as { promisedDate?: string; amountReference?: string | null };
  if (!p?.promisedDate) return null;
  const due = new Date(p.promisedDate);
  const daysOut = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
  return (
    <Badge tone="amber">
      pauses collection until {due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
      {daysOut > 0 ? ` (${daysOut}d)` : ''}
      {p.amountReference ? ` — ${p.amountReference}` : ''}
    </Badge>
  );
}
