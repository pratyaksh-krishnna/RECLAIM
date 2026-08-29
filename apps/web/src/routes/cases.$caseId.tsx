import { Link, createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Lock, Scale } from 'lucide-react';
import { useState } from 'react';
import { api, formatINRExact, getUser, timeAgo } from '../lib/api';
import type { CaseDetail, RuleTraceEntry } from '../lib/types';
import { ImmutableChip, VoiceNote, splitRuns } from '../components/VoiceNote';
import {
  Badge,
  Button,
  CAUSE_LABELS,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chip,
  Eyebrow,
  Loading,
  Meter,
  Money,
  Note,
  STATE_LABELS,
  STATE_TONES,
  Source,
  Tooltip,
  formatDay,
  formatMoment,
} from '../components/ui/primitives';
import { cn } from '../lib/cn';

export const Route = createFileRoute('/cases/$caseId')({ component: CaseView });

function CaseView() {
  const { caseId } = Route.useParams();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['case', caseId], queryFn: () => api<CaseDetail>(`/recovery/cases/${caseId}`) });
  const canAct = getUser()?.role !== 'viewer';

  const stop = useMutation({
    mutationFn: () => api(`/recovery/cases/${caseId}/stop`, { method: 'POST', body: JSON.stringify({ reason: 'human_request' }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['case', caseId] }),
  });
  const analyze = useMutation({
    mutationFn: () => api(`/recovery/cases/${caseId}/analyze`, { method: 'POST', body: '{}' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['case', caseId] }),
  });
  const approve = useMutation({
    mutationFn: (args: { interventionId: string; decision: 'approve' | 'deny' }) =>
      api(`/recovery/cases/${caseId}/approve`, { method: 'POST', body: JSON.stringify(args) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['case', caseId] }),
  });

  if (!data) return <Loading shape="case" />;
  const { case: c, customer, invoice } = data;
  const isTerminal = ['recovered', 'stopped', 'lost'].includes(c.state);
  const pendingIntervention = data.interventions.find((i) => i.status === 'pending_approval');
  const latestDiagnosis = [...data.agentDecisions].reverse().find((d) => d.agent === 'diagnosis' && d.schemaValid);
  const latestSummary = [...data.audit].reverse().find((a) => a.eventType === 'case.summary');

  return (
    <div>
      <Link
        to="/cases"
        className="mb-4 inline-flex items-center gap-1.5 text-2xs text-ash transition-colors ease-desk hover:text-brass"
      >
        <ChevronLeft size={13} />
        Back to the Risk Queue
      </Link>

      {/* header */}
      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="widest text-[1.35rem] font-semibold leading-none tracking-tight text-ink">
          {customer?.name ?? 'Case'}
        </h1>
        <Badge tone={STATE_TONES[c.state] ?? 'neutral'}>{STATE_LABELS[c.state] ?? c.state}</Badge>
        {c.holdoutArm === 'holdout' && (
          <Tooltip label="Holdout: observe-only control. Every intervention is policy-locked so this case measures the no-touch baseline.">
            <Badge tone="violet" className="cursor-help">
              <Lock size={9} />
              holdout — action-locked
            </Badge>
          </Tooltip>
        )}
        {customer?.optedOut && <Badge tone="red">opted out — every message suppressed</Badge>}
        <div className="ml-auto flex gap-2">
          {canAct && !isTerminal && (
            <>
              <Button variant="outline" size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending || c.holdoutArm === 'holdout'}>
                Send back to agents
              </Button>
              <Button variant="destructive" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
                Stop this case
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        {/* ------------------------ the narrative ------------------------ */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="keyline keyline-agent">
            <CardHeader>
              <CardTitle>Why this is at risk</CardTitle>
              <span className="ml-auto">
                <Source kind="agent" detail={latestDiagnosis?.model} />
              </span>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <span className="wide text-base font-semibold text-ink">
                  {c.causeHypothesis ? (CAUSE_LABELS[c.causeHypothesis] ?? c.causeHypothesis) : 'Not yet diagnosed'}
                </span>
                {c.causeConfidence && <Meter value={Number(c.causeConfidence)} label="confidence" />}
              </div>
              {c.urgencySignals.length > 0 && (
                <div>
                  <Eyebrow>What makes it urgent</Eyebrow>
                  <ul className="mt-2 space-y-1.5">
                    {c.urgencySignals.map((s) => (
                      <li key={s} className="flex gap-2.5 text-xs leading-relaxed text-ash">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-marigold" aria-hidden />
                        {s.replace(/_/g, ' ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {latestDiagnosis && <Evidence output={latestDiagnosis.output} />}
            </CardContent>
          </Card>

          <Card className="keyline keyline-agent">
            <CardHeader>
              <CardTitle>Proposed action</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <Recommended data={data} />
              {pendingIntervention && canAct && (
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-rule pt-4">
                  <Button variant="success" size="sm" onClick={() => approve.mutate({ interventionId: pendingIntervention.id, decision: 'approve' })}>
                    Approve
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => approve.mutate({ interventionId: pendingIntervention.id, decision: 'deny' })}>
                    Deny
                  </Button>
                  <span className="text-2xs text-ash">Approving runs it now. The amount comes from the invoice, not the agent.</span>
                </div>
              )}
            </CardContent>
          </Card>

          {latestSummary && (
            <Card className="keyline keyline-agent">
              <CardHeader>
                <CardTitle>Handover note</CardTitle>
                <span className="ml-auto">
                  <Source kind="agent" />
                </span>
              </CardHeader>
              <CardContent>
                <Note text={String((latestSummary.payload as { summary?: string }).summary ?? '')} />
              </CardContent>
            </Card>
          )}

          {data.promises.length > 0 && <PromiseTracker promises={data.promises} />}

          {/* policy verdicts */}
          <Card className="keyline keyline-machine">
            <CardHeader>
              <CardTitle>Policy verdicts</CardTitle>
              <span className="ml-auto">
                <Source kind="policy" />
              </span>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.policyDecisions.length === 0 && (
                <p className="text-sm text-ash">Nothing has reached the policy gate yet.</p>
              )}
              {[...data.policyDecisions].reverse().map((pd) => <PolicyVerdict key={pd.id} pd={pd} />)}
            </CardContent>
          </Card>

          {/* communications with immutable-slot preview */}
          <Card>
            <CardHeader>
              <CardTitle>Messages</CardTitle>
              <span className="ml-auto text-2xs text-ash">
                {data.communications.length} on this case
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.communications.length === 0 && <p className="text-sm text-ash">Nothing has been sent.</p>}
              {data.communications.map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    'rounded-md border p-3.5 text-sm',
                    m.direction === 'inbound' ? 'border-steel/30 bg-steel/[0.06]' : 'border-rule bg-ink/[0.022]',
                  )}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-2xs text-ash">
                    <Badge tone={m.direction === 'inbound' ? 'blue' : 'neutral'}>
                      {m.direction === 'inbound'
                        ? 'from the customer'
                        : m.channel === 'whatsapp_voice' && m.consentSnapshot?.delivered === false
                          ? /* the audio is real and the delivery never happened; the
                               console must not imply a customer heard it */
                            'not sent'
                          : 'sent'}
                    </Badge>
                    {m.channel !== 'email' && (
                      <Chip>{m.channel === 'whatsapp_voice' ? 'whatsapp · voice' : 'whatsapp'}</Chip>
                    )}
                    {m.templateId && <Chip>{m.templateId}</Chip>}
                    {m.language && <span className="uppercase">{m.language}</span>}
                    <span className="ml-auto">{timeAgo(m.sentAt)}</span>
                  </div>
                  {m.renderedSubject && <div className="mb-1 font-medium text-ink">{m.renderedSubject}</div>}
                  {m.channel === 'whatsapp_voice' ? (
                    <VoiceNote
                      caseId={caseId}
                      communicationId={m.id}
                      script={m.renderedBody}
                      delivered={m.consentSnapshot?.delivered === true}
                    />
                  ) : (
                    <MessageBody body={m.renderedBody} outbound={m.direction === 'outbound'} />
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Everything that happened</CardTitle>
            </CardHeader>
            <CardContent>
              <Timeline data={data} />
            </CardContent>
          </Card>
        </div>

        {/* --------------------------- the facts --------------------------- */}
        <div className="lg:sticky lg:top-16">
          <Card className="keyline keyline-machine">
            <CardHeader>
              <CardTitle>Exposure</CardTitle>
              <span className="ml-auto">
                <Source kind="ledger" />
              </span>
            </CardHeader>
            <CardContent>
              <Money value={formatINRExact(c.exposurePaise)} size="lg" />

              <dl className="mt-5 space-y-0">
                <Fact label="Invoice">
                  <Chip>{invoice?.providerInvoiceId ?? invoice?.id.slice(0, 8) ?? '—'}</Chip>
                </Fact>
                <Fact label="Invoice status">
                  <span className="text-ink">{invoice?.status ?? '—'}</span>
                </Fact>
                <Fact label="Due">
                  <span className="tnum text-ink">
                    {invoice ? formatDay(invoice.dueDate) : '—'}
                  </span>
                </Fact>
                <Fact label="Opened">
                  <span className="text-ink">{timeAgo(c.openedAt)}</span>
                </Fact>
                <Fact label="Attribution window ends">
                  <span className="tnum text-ink">
                    {formatDay(c.attributionWindowEndsAt)}
                  </span>
                </Fact>
              </dl>

              <div className="mt-5 border-t border-rule pt-4">
                <Eyebrow>Budget spent on this case</Eyebrow>
                <div className="mt-3 space-y-3">
                  <Budget label="Recovery attempts" used={c.recoveryAttemptCount} cap={4} />
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-ash">Agent calls</span>
                    <span className="tnum text-ink">{c.agentInvocationCount}</span>
                  </div>
                </div>
                <p className="mt-3 text-2xs leading-relaxed text-ash">
                  Attempts are capped by policy. When the cap is reached the case stops rather than trying again.
                </p>
              </div>

              {c.waitUntil && (
                <div className="mt-4 rounded-md border border-rule bg-ink/[0.032] p-3">
                  <Eyebrow>Paused</Eyebrow>
                  <p className="tnum mt-1 text-xs text-ink">
                    until {formatMoment(c.waitUntil)}
                  </p>
                </div>
              )}
              {c.stopReason && (
                <div className="mt-4 rounded-md border border-rule bg-ink/[0.032] p-3">
                  <Eyebrow>Stopped because</Eyebrow>
                  <p className="mt-1 text-xs text-ink">{c.stopReason.replace(/_/g, ' ')}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {customer && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Customer</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-0">
                  <Fact label="Name">
                    <span className="text-ink">{customer.name}</span>
                  </Fact>
                  <Fact label="Email">
                    <span className="truncate text-ink">{customer.email}</span>
                  </Fact>
                  <Fact label="Timezone">
                    <span className="text-ink">{customer.timezone}</span>
                  </Fact>
                  <Fact label="Contactable">
                    <span className={customer.optedOut ? 'text-crimson' : 'text-sage'}>
                      {customer.optedOut ? 'opted out' : 'yes'}
                    </span>
                  </Fact>
                </dl>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-rule/60 py-2 text-xs last:border-0">
      <dt className="shrink-0 text-ash">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function Budget({ label, used, cap }: { label: string; used: number; cap: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-ash">{label}</span>
        <span className="tnum text-ink">
          {used} <span className="text-ash">of {cap}</span>
        </span>
      </div>
      <div className="mt-1.5 flex gap-1">
        {Array.from({ length: cap }).map((_, i) => (
          <span
            key={i}
            className={cn('h-1 flex-1 rounded-full', i < used ? 'bg-brass' : 'bg-ink/[0.07]')}
          />
        ))}
      </div>
    </div>
  );
}

function Recommended({ data }: { data: CaseDetail }) {
  const current = [...data.interventions].reverse().find((i) => ['proposed', 'pending_approval', 'approved', 'executing'].includes(i.status));
  const last = current ?? [...data.interventions].reverse()[0];
  if (!last) return <p className="text-ash">No action has been proposed yet.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip className="text-xs">{last.actionType}</Chip>
        <Badge tone={last.status === 'executed' ? 'green' : last.status === 'pending_approval' ? 'amber' : last.status === 'denied' ? 'red' : 'neutral'}>
          {last.status.replace(/_/g, ' ')}
        </Badge>
        {last.confidence && <Meter value={Number(last.confidence)} />}
        <span className="ml-auto text-2xs text-ash">proposed by {last.proposedBy}</span>
      </div>
      {last.rationale && <p className="leading-relaxed text-ink/90">{last.rationale}</p>}
      {last.stopConditions.length > 0 && (
        <div className="rounded-md border border-rule bg-ink/[0.022] p-3">
          <Eyebrow>Stops if</Eyebrow>
          <ul className="mt-1.5 space-y-1">
            {last.stopConditions.map((s) => (
              <li key={s} className="text-2xs text-ash">
                {s.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Evidence({ output }: { output: unknown }) {
  const ev = (output as { evidence?: Array<{ recordType: string; recordId: string; field: string; observation: string }> }).evidence;
  if (!ev?.length) return null;
  return (
    <div className="rounded-md border border-rule bg-ink/[0.022] p-3">
      <Eyebrow>Records it cited</Eyebrow>
      <ul className="mt-2 space-y-1.5">
        {ev.map((e, i) => (
          <li key={i} className="text-xs leading-relaxed">
            <span className="font-mono text-2xs text-brass">
              {e.recordType}[{e.recordId.slice(0, 8)}].{e.field}
            </span>
            <span className="mx-1.5 text-ash">→</span>
            <span className="text-ink/90">{e.observation}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PolicyVerdict({ pd }: { pd: CaseDetail['policyDecisions'][number] }) {
  const [open, setOpen] = useState(false);
  const tone = pd.verdict === 'ALLOW' ? 'green' : pd.verdict === 'DENY' ? 'red' : 'amber';
  return (
    <div className="overflow-hidden rounded-md border border-rule">
      <button
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ease-desk hover:bg-ink/[0.032]"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} className="text-ash" /> : <ChevronRight size={13} className="text-ash" />}
        <Scale size={13} className="text-brass" />
        <Badge tone={tone as 'green' | 'red' | 'amber'}>{pd.verdict}</Badge>
        <span className="truncate text-xs text-ash">{pd.reason ?? 'every rule passed'}</span>
        <span className="ml-auto shrink-0 font-mono text-2xs text-ash">
          v{pd.policyVersion} · {timeAgo(pd.createdAt)}
        </span>
      </button>
      {open && (
        <div className="border-t border-rule bg-ink/[0.022] px-3 py-2">
          <table className="w-full text-2xs">
            <tbody>
              {pd.ruleTrace.map((r: RuleTraceEntry) => (
                <tr key={r.ruleId} className="border-b border-rule/50 last:border-0">
                  <td className="py-1.5 pr-3 font-mono text-ink/80">{r.ruleId}</td>
                  <td className="py-1.5 pr-3 text-ash">{r.category}</td>
                  <td className="py-1.5 pr-3">
                    <Badge tone={r.outcome === 'pass' ? 'green' : r.outcome === 'deny' ? 'red' : r.outcome === 'require_approval' ? 'amber' : 'neutral'}>
                      {r.outcome.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="py-1.5 text-ash">{r.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Outbound message preview with immutable (server-injected) segments visually locked. */
/**
 * Written messages. Shares splitRuns with the voice transcript so there is ONE
 * definition of what the server injected — the email and the voice note carry
 * the same values in different registers, and a reader should see them marked
 * the same way in both.
 */
function MessageBody({ body, outbound }: { body: string; outbound: boolean }) {
  if (!outbound) return <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink/90">{body}</pre>;
  return (
    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink/90">
      {splitRuns(body).map((r, i) =>
        r.immutable ? <ImmutableChip key={i}>{r.text}</ImmutableChip> : <span key={i}>{r.text}</span>,
      )}
    </pre>
  );
}

function Timeline({ data }: { data: CaseDetail }) {
  type Item = { at: string; kind: string; title: string; detail?: string | undefined; tone?: 'red' | 'green' | 'amber' | undefined };
  const items: Item[] = [
    ...data.audit.map((a) => ({
      at: a.createdAt,
      kind: a.actorType,
      title: a.eventType,
      detail: a.eventType === 'case.transition' ? `${(a.payload as { from?: string }).from} → ${(a.payload as { to?: string }).to}` : undefined,
      ...(a.eventType.startsWith('safety.') ? { tone: 'red' as const } : {}),
    })),
    ...data.agentDecisions.map((d) => ({
      at: d.createdAt,
      kind: 'agent',
      title: `${d.agent} (${d.model})`,
      detail: `${d.schemaValid ? 'schema-valid' : 'SCHEMA FAILURE'} · ${d.latencyMs}ms · prompt ${d.promptVersionHash.slice(0, 8)}${d.confidence ? ` · conf ${Math.round(Number(d.confidence) * 100)}%` : ''}`,
      ...(d.schemaValid ? {} : { tone: 'red' as const }),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (items.length === 0) return <p className="text-sm text-ash">Nothing recorded yet.</p>;

  let lastDay = '';

  return (
    <ol className="space-y-0">
      {items.map((item, i) => {
        // the date is repeated on every row otherwise; it only carries
        // information on the row where the day actually turns over
        const day = formatDay(item.at);
        const newDay = day !== lastDay;
        lastDay = day;
        return (
          <li key={i}>
            {newDay && (
              <div className="flex items-center gap-3 pb-2 pt-1 first:pt-0">
                <span className="eyebrow shrink-0">{day}</span>
                <span className="h-px flex-1 bg-rule" aria-hidden />
              </div>
            )}
            <div className="grid grid-cols-[auto_1fr] gap-x-3">
              {/* the time gutter doubles as the rail everything hangs from */}
              <div className="relative flex w-14 shrink-0 justify-end pr-4 pt-[3px] text-right">
                <span className="tnum font-mono text-2xs text-ash/80">
                  {new Date(item.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
                <span className="absolute right-0 top-0 h-full w-px bg-rule" aria-hidden />
                <span className="absolute -right-[3px] top-[6px] h-[7px] w-[7px] rounded-full ring-[3px] ring-panel" aria-hidden>
                  <span
                    className={cn(
                      'block h-full w-full rounded-full',
                      item.tone === 'red' ? 'bg-crimson' : item.kind === 'agent' ? 'bg-steel' : 'bg-brass/70',
                    )}
                  />
                </span>
              </div>
              <div className="min-w-0 pb-3.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {item.tone === 'red' && <AlertTriangle size={11} className="text-crimson" />}
                  <span className="font-mono text-xs text-ink">{item.title}</span>
                  <span className="eyebrow">{item.kind}</span>
                </div>
                {item.detail && <div className="mt-0.5 text-2xs text-ash">{item.detail}</div>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Promise-to-pay tracker. A promise pauses collection until the promised date,
 * so the operator who accepted it needs to see the clock they started: when it
 * is due, how long is left, and whether it was kept or broken. The hourly sweep
 * flips an unkept promise to `broken` once the date passes with the invoice
 * still unpaid, which re-opens the case for follow-up.
 */
function PromiseTracker({ promises }: { promises: CaseDetail['promises'] }) {
  const day = 86_400_000;
  return (
    <Card className="keyline keyline-machine">
      <CardHeader>
        <CardTitle>Promise to pay</CardTitle>
        <span className="ml-auto text-2xs text-ash">collection is paused while a promise is open</span>
      </CardHeader>
      <CardContent className="space-y-3">
        {[...promises]
          .sort((a, b) => +new Date(b.promisedDate) - +new Date(a.promisedDate))
          .map((p) => {
            const due = new Date(p.promisedDate);
            const daysLeft = Math.ceil((due.getTime() - Date.now()) / day);
            const tone = p.status === 'kept' ? 'green' : p.status === 'broken' ? 'red' : 'amber';
            return (
              <div key={p.id} className="rounded-md border border-rule bg-ink/[0.022] p-3.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={tone}>{p.status}</Badge>
                  <span className="tnum font-medium text-ink">
                    due {formatDay(p.promisedDate)}
                  </span>
                  {p.status === 'open' && (
                    <span className={cn('tnum text-xs', daysLeft < 0 ? 'text-crimson' : 'text-ash')}>
                      {daysLeft < 0
                        ? `overdue by ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'}`
                        : daysLeft === 0
                          ? 'due today'
                          : `${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining`}
                    </span>
                  )}
                  {p.amountReference && <span className="text-xs text-ash">— {p.amountReference}</span>}
                </div>
                {p.status === 'open' && (
                  <p className="mt-2 text-2xs leading-relaxed text-ash">
                    If the invoice is still unpaid on that date, the promise is marked broken and the case re-opens
                    for follow-up.
                  </p>
                )}
              </div>
            );
          })}
      </CardContent>
    </Card>
  );
}
