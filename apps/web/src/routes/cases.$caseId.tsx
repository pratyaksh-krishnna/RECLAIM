import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, formatINRExact, getUser, timeAgo } from '../lib/api';
import type { CaseDetail, RuleTraceEntry } from '../lib/types';
import { Badge, Button, CAUSE_LABELS, Card, CardContent, CardHeader, CardTitle, STATE_TONES, Tooltip } from '../components/ui/primitives';
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

  if (!data) return <p className="text-muted">Loading…</p>;
  const { case: c, customer, invoice } = data;
  const isTerminal = ['recovered', 'stopped', 'lost'].includes(c.state);
  const pendingIntervention = data.interventions.find((i) => i.status === 'pending_approval');
  const latestDiagnosis = [...data.agentDecisions].reverse().find((d) => d.agent === 'diagnosis' && d.schemaValid);
  const latestSummary = [...data.audit].reverse().find((a) => a.eventType === 'case.summary');

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight">{customer?.name ?? 'Case'}</h1>
        <Badge tone={STATE_TONES[c.state] ?? 'neutral'}>{c.state}</Badge>
        {c.holdoutArm === 'holdout' && (
          <Tooltip label="Holdout: observe-only control. Every intervention is policy-locked so this case measures the no-touch baseline.">
            <Badge tone="violet" className="cursor-help"><Lock size={10} className="mr-1" />holdout — action-locked</Badge>
          </Tooltip>
        )}
        {customer?.optedOut && <Badge tone="red">customer opted out — global suppression</Badge>}
        <div className="ml-auto flex gap-2">
          {canAct && !isTerminal && (
            <>
              <Button variant="outline" size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending || c.holdoutArm === 'holdout'}>
                Re-analyze
              </Button>
              <Button variant="destructive" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
                Stop workflow
              </Button>
            </>
          )}
        </div>
      </div>

      {/* top row: exposure & why at risk */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Exposure</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{formatINRExact(c.exposurePaise)}</div>
            <div className="mt-2 space-y-1 text-sm text-muted">
              <div>Invoice: {invoice?.providerInvoiceId ?? invoice?.id.slice(0, 8)} · {invoice?.status}</div>
              <div>Due {invoice ? new Date(invoice.dueDate).toLocaleDateString('en-IN') : '—'}</div>
              <div>Attempts used: {c.recoveryAttemptCount} / 4 · agent calls: {c.agentInvocationCount}</div>
              <div>Attribution window ends {new Date(c.attributionWindowEndsAt).toLocaleDateString('en-IN')}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Why at risk / diagnosis</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge tone="blue">{c.causeHypothesis ? (CAUSE_LABELS[c.causeHypothesis] ?? c.causeHypothesis) : 'not yet diagnosed'}</Badge>
              {c.causeConfidence && <span className="tabular-nums text-muted">{Math.round(Number(c.causeConfidence) * 100)}% confidence</span>}
            </div>
            {c.urgencySignals.length > 0 && (
              <ul className="list-inside list-disc text-muted">
                {c.urgencySignals.map((s) => <li key={s}>{s}</li>)}
              </ul>
            )}
            {latestDiagnosis && <Evidence output={latestDiagnosis.output} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recommended intervention</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <Recommended data={data} />
            {pendingIntervention && canAct && (
              <div className="mt-3 flex gap-2">
                <Button variant="success" size="sm" onClick={() => approve.mutate({ interventionId: pendingIntervention.id, decision: 'approve' })}>
                  Approve
                </Button>
                <Button variant="outline" size="sm" onClick={() => approve.mutate({ interventionId: pendingIntervention.id, decision: 'deny' })}>
                  Deny
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {latestSummary && (
        <Card>
          <CardHeader><CardTitle>Escalation summary</CardTitle></CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{String((latestSummary.payload as { summary?: string }).summary ?? '')}</CardContent>
        </Card>
      )}

      {/* policy verdicts */}
      <Card>
        <CardHeader><CardTitle>Policy verdicts</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.policyDecisions.length === 0 && <p className="text-sm text-muted">No policy evaluations yet.</p>}
          {[...data.policyDecisions].reverse().map((pd) => <PolicyVerdict key={pd.id} pd={pd} />)}
        </CardContent>
      </Card>

      {/* communications with immutable-slot preview */}
      <Card>
        <CardHeader><CardTitle>Messages</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {data.communications.length === 0 && <p className="text-sm text-muted">No messages yet.</p>}
          {data.communications.map((m) => (
            <div key={m.id} className={cn('rounded-md border p-3 text-sm', m.direction === 'inbound' ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface')}>
              <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                <Badge tone={m.direction === 'inbound' ? 'blue' : 'neutral'}>{m.direction}</Badge>
                {m.templateId && <code>{m.templateId}</code>}
                {m.language && <span>{m.language}</span>}
                <span className="ml-auto">{timeAgo(m.sentAt)}</span>
              </div>
              {m.renderedSubject && <div className="font-medium">{m.renderedSubject}</div>}
              <MessageBody body={m.renderedBody} outbound={m.direction === 'outbound'} />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* timeline */}
      <Card>
        <CardHeader><CardTitle>Full timeline</CardTitle></CardHeader>
        <CardContent>
          <Timeline data={data} />
        </CardContent>
      </Card>
    </div>
  );
}

function Recommended({ data }: { data: CaseDetail }) {
  const current = [...data.interventions].reverse().find((i) => ['proposed', 'pending_approval', 'approved', 'executing'].includes(i.status));
  const last = current ?? [...data.interventions].reverse()[0];
  if (!last) return <p className="text-muted">No proposal yet.</p>;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <code className="rounded bg-black/5 px-1.5 py-0.5 text-xs">{last.actionType}</code>
        <Badge tone={last.status === 'executed' ? 'green' : last.status === 'pending_approval' ? 'amber' : last.status === 'denied' ? 'red' : 'neutral'}>{last.status}</Badge>
        {last.confidence && <span className="tabular-nums text-muted">{Math.round(Number(last.confidence) * 100)}%</span>}
        <span className="text-xs text-muted">by {last.proposedBy}</span>
      </div>
      {last.rationale && <p className="text-muted">{last.rationale}</p>}
      {last.stopConditions.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase text-muted">Stop conditions</div>
          <ul className="list-inside list-disc text-muted">
            {last.stopConditions.map((s) => <li key={s}>{s}</li>)}
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
    <div className="mt-1">
      <div className="text-xs font-semibold uppercase text-muted">Cited evidence</div>
      <ul className="mt-1 space-y-1">
        {ev.map((e, i) => (
          <li key={i} className="rounded bg-black/5 px-2 py-1 font-mono text-xs">
            {e.recordType}[{e.recordId.slice(0, 8)}].{e.field} — <span className="font-sans">{e.observation}</span>
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
    <div className="rounded-md border border-border">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <ShieldCheck size={14} className="text-muted" />
        <Badge tone={tone as 'green' | 'red' | 'amber'}>{pd.verdict}</Badge>
        <span className="text-muted">{pd.reason ?? 'all rules passed'}</span>
        <span className="ml-auto text-xs text-muted">policy v{pd.policyVersion} · {timeAgo(pd.createdAt)}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <table className="w-full text-xs">
            <tbody>
              {pd.ruleTrace.map((r: RuleTraceEntry) => (
                <tr key={r.ruleId} className="border-b border-border/40 last:border-0">
                  <td className="py-1 pr-2 font-mono">{r.ruleId}</td>
                  <td className="py-1 pr-2 text-muted">{r.category}</td>
                  <td className="py-1 pr-2">
                    <Badge tone={r.outcome === 'pass' ? 'green' : r.outcome === 'deny' ? 'red' : r.outcome === 'require_approval' ? 'amber' : 'neutral'}>
                      {r.outcome}
                    </Badge>
                  </td>
                  <td className="py-1 text-muted">{r.detail ?? ''}</td>
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
function MessageBody({ body, outbound }: { body: string; outbound: boolean }) {
  if (!outbound) return <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{body}</pre>;
  const parts = body.split(/(₹[\d,.]+|https?:\/\/\S+|INV-\S+|\d{1,2} [A-Z][a-z]+ \d{4})/g);
  return (
    <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">
      {parts.map((p, i) =>
        /^(₹|https?:\/\/|INV-|\d{1,2} [A-Z])/.test(p) ? (
          <Tooltip key={i} label="Immutable slot — injected by the server from database state. The AI cannot write or alter this value.">
            <span className="rounded bg-warn/15 px-1 font-medium text-warn ring-1 ring-warn/30 cursor-help">
              <Lock size={9} className="mr-0.5 inline" />{p}
            </span>
          </Tooltip>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </pre>
  );
}

function Timeline({ data }: { data: CaseDetail }) {
  type Item = { at: string; kind: string; title: string; detail?: string; tone?: 'red' | 'green' | 'amber' };
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

  return (
    <ol className="relative ml-2 space-y-2 border-l border-border pl-4 text-sm">
      {items.map((item, i) => (
        <li key={i} className="relative">
          <span className={cn('absolute -left-[21px] top-1.5 h-2 w-2 rounded-full', item.tone === 'red' ? 'bg-bad' : item.kind === 'agent' ? 'bg-accent' : 'bg-border')} />
          <div className="flex items-baseline gap-2">
            {item.tone === 'red' && <AlertTriangle size={12} className="text-bad" />}
            <span className="font-medium">{item.title}</span>
            <span className="text-xs uppercase text-muted">{item.kind}</span>
            <span className="ml-auto shrink-0 text-xs text-muted">{new Date(item.at).toLocaleString('en-IN')}</span>
          </div>
          {item.detail && <div className="text-xs text-muted">{item.detail}</div>}
        </li>
      ))}
    </ol>
  );
}
