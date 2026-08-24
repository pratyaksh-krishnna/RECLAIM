import { Link, createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, formatINR, getUser, timeAgo } from '../lib/api';
import type { HumanQueueItem } from '../lib/types';
import {
  Badge,
  Button,
  CAUSE_LABELS,
  Card,
  CardContent,
  Chip,
  Empty,
  Eyebrow,
  Meter,
  Note,
  PageHeader,
} from '../components/ui/primitives';
import { cn } from '../lib/cn';

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

  const atStake = data.reduce((sum, d) => sum + d.caseRow.exposurePaise, 0);

  return (
    <div>
      <PageHeader
        title="Human Inbox"
        lede={
          data.length === 0
            ? 'Everything the system can decide on its own, it already has.'
            : 'Each item below is stopped until you decide. Nothing moves in the meantime.'
        }
      >
        {data.length > 0 && (
          <span className="flex items-center gap-2.5">
            <Eyebrow>Held up</Eyebrow>
            <span className="wide tnum text-sm font-semibold text-brass">{formatINR(atStake)}</span>
          </span>
        )}
      </PageHeader>

      {data.length === 0 && (
        <Card>
          <Empty
            title="Nothing needs a person right now."
            hint="Proposals under the policy exposure limit are approved automatically. Anything above it, or anything the pipeline cannot resolve, will appear here."
          />
        </Card>
      )}

      {disputes.length > 0 && (
        <Section
          icon={<Lock size={12} className="text-peri" />}
          title="Disputed"
          note="Outreach is frozen until a human resolves it"
          count={disputes.length}
        >
          {disputes.map((row) => (
            <DisputeCard key={row.caseRow.id} row={row} isAdmin={isAdmin} />
          ))}
        </Section>
      )}

      {escalations.length > 0 && (
        <Section
          icon={<AlertTriangle size={12} className="text-crimson" />}
          title="Escalated"
          note="The pipeline stopped and needs your decision"
          count={escalations.length}
        >
          {escalations.map((row) => (
            <EscalationCard key={row.caseRow.id} row={row} canAct={canAct} />
          ))}
        </Section>
      )}

      {approvals.length > 0 && (
        <Section
          icon={<ShieldCheck size={12} className="text-marigold" />}
          title="Awaiting approval"
          note="An agent proposed these; policy requires a person to say yes"
          count={approvals.length}
        >
          {approvals.map((row) => (
            <ApprovalCard key={row.intervention!.id} row={row} canAct={canAct} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  note,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8 last:mb-0">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-rule pb-2.5">
        <span className="translate-y-[1px]">{icon}</span>
        <h2 className="eyebrow text-ink">{title}</h2>
        <span className="tnum text-2xs text-ash">{count}</span>
        <span className="text-2xs text-ash">— {note}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
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
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CaseIdentity row={row} />
          <span className="wide tnum text-base font-semibold text-brass">{formatINR(row.caseRow.exposurePaise)}</span>
          <Chip>{iv.actionType}</Chip>
          <PromiseDetail actionType={iv.actionType} params={iv.params} />
          {iv.confidence && <Meter value={Number(iv.confidence)} />}
          <span className="text-2xs text-ash">{timeAgo(iv.createdAt)}</span>
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
        </div>

        {iv.rationale && (
          <div className="keyline keyline-agent mt-3">
            <Note text={iv.rationale} label="Why the agent proposed it" />
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
    <Card className="border-peri/30">
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CaseIdentity row={row} />
          <span className="wide tnum text-base font-semibold text-brass">{formatINR(row.caseRow.exposurePaise)}</span>
          <Badge tone="violet">
            <Lock size={9} />
            outreach frozen
          </Badge>
          {row.escalationReason && <span className="text-xs text-ash">{row.escalationReason}</span>}
          {isAdmin && !outcome && (
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setOutcome('rejected')}>
                Reject the dispute — resume recovery
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setOutcome('upheld')}>
                Uphold it — write off
              </Button>
            </div>
          )}
          {!isAdmin && <span className="ml-auto text-2xs text-ash">Only an admin can resolve a dispute.</span>}
        </div>

        {row.summary && (
          <div className="keyline keyline-agent mt-3">
            <Note text={row.summary} label="What the agent found" />
          </div>
        )}

        {outcome && (
          <div className="mt-4 space-y-3 rounded-md border border-rule bg-ink/[0.032] p-3.5">
            <p className="text-sm text-ink">
              {outcome === 'rejected'
                ? 'This resumes collection on a charge the customer formally contested. Your name goes on the record.'
                : 'This closes the case as uncollectable. Nothing further is sent.'}
            </p>
            <TextInput
              value={reason}
              onChange={setReason}
              placeholder="Why? Recorded in the audit trail — at least 10 characters"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={outcome === 'rejected' ? 'default' : 'destructive'}
                disabled={reason.trim().length < 10 || submit.isPending}
                onClick={() => submit.mutate()}
              >
                {outcome === 'rejected' ? 'Reject the dispute' : 'Uphold the dispute'}
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
    <Card className="border-crimson/25">
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CaseIdentity row={row} />
          <span className="wide tnum text-base font-semibold text-brass">{formatINR(row.caseRow.exposurePaise)}</span>
          {row.escalationReason && <Badge tone="red">{row.escalationReason.replace(/_/g, ' ')}</Badge>}
          {locked && (
            <Badge tone="violet">
              <Lock size={9} />
              holdout — action-locked
            </Badge>
          )}
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
                Stop this case
              </Button>
            </div>
          )}
        </div>

        {row.summary && (
          <div className="keyline keyline-agent mt-3">
            <Note text={row.summary} label="Handover note" />
          </div>
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
    <div className="keyline keyline-quiet mt-4 space-y-4 rounded-md border border-rule bg-ink/[0.032] p-4">
      <Eyebrow>Propose an action</Eyebrow>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Action">
          <Select value={type} onChange={(v) => { setType(v as ComposableType); setF({}); }}>
            {COMPOSABLE.map((a) => (
              <option key={a.type} value={a.type}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>

        {type === 'send_email' && (
          <>
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
          </>
        )}

        {dateField && (
          <Field label={type === 'record_promise_to_pay' ? 'Promised date' : 'When'}>
            <input
              type="datetime-local"
              className={inputClass}
              value={f[dateField] ?? ''}
              onChange={(e) => set(dateField, e.target.value)}
            />
          </Field>
        )}
      </div>

      {type === 'schedule_reminder' && (
        <Field label="Note">
          <TextInput value={f.note ?? ''} onChange={(v) => set('note', v)} placeholder="Why this reminder" />
        </Field>
      )}
      {type === 'mark_wait' && (
        <Field label="Waiting for">
          <TextInput value={f.waitingFor ?? ''} onChange={(v) => set('waitingFor', v)} placeholder="What we expect to happen" />
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

      <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-3">
        <Button size="sm" disabled={propose.isPending || incomplete} onClick={() => propose.mutate(action())}>
          Propose
        </Button>
        <span className="text-2xs text-ash">
          The policy engine evaluates this the same way it evaluates an agent's proposal. Choosing the action does not
          skip the gate.
        </span>
      </div>
      <MutationError error={propose.error} />
    </div>
  );
}

/* -------------------------------- fragments -------------------------------- */

const inputClass =
  'h-8 rounded-md border border-rule bg-paper/60 px-2.5 text-sm text-ink placeholder:text-ash/60 transition-colors ease-desk hover:border-ash/40';

function CaseIdentity({ row }: { row: HumanQueueItem }) {
  return (
    <div className="min-w-44">
      <Link
        to="/cases/$caseId"
        params={{ caseId: row.caseRow.id }}
        className="font-medium text-ink decoration-brass/50 underline-offset-4 hover:underline"
      >
        {row.customerName}
      </Link>
      <div className="mt-0.5 text-2xs text-ash">
        {row.caseRow.causeHypothesis
          ? (CAUSE_LABELS[row.caseRow.causeHypothesis] ?? row.caseRow.causeHypothesis)
          : 'undiagnosed'}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="eyebrow">{label}</label>
      {children}
    </div>
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select className={cn(inputClass, 'pr-1.5')} value={value} onChange={(e) => onChange(e.target.value)}>
      {children}
    </select>
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className={cn(inputClass, 'w-96 max-w-full')}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? `${error.status}: ${error.message}` : String(error);
  return (
    <p className="mt-3 rounded-md border border-crimson/30 bg-crimson/10 px-3 py-2 font-mono text-2xs text-crimson">
      {message}
    </p>
  );
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
