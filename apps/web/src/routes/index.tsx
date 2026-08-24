import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { api, formatINR } from '../lib/api';
import type { RecoveryReport, RevenueRisk } from '../lib/types';
import { Card, CardContent, CardHeader, CardTitle, Eyebrow, Money, PageHeader } from '../components/ui/primitives';
import { cn } from '../lib/cn';

export const Route = createFileRoute('/')({ component: CommandCenter });

function CommandCenter() {
  const { data: risk } = useQuery({ queryKey: ['revenue-risk'], queryFn: () => api<RevenueRisk>('/analytics/revenue-risk') });
  const { data: rec } = useQuery({ queryKey: ['recovery'], queryFn: () => api<RecoveryReport>('/analytics/recovery') });

  const incrementalPct = rec ? (rec.incremental.diff * 100).toFixed(1) : '…';
  const treatRate = rec && rec.treatment.cases > 0 ? ((rec.treatment.recovered / rec.treatment.cases) * 100).toFixed(1) : '0';

  const open = risk?.openCases ?? 0;
  const approvals = risk?.pendingApprovals ?? 0;
  const escalated = risk?.escalated ?? 0;
  const disputed = risk?.disputed ?? 0;
  // pending_approval, escalated and disputed are mutually exclusive non-terminal
  // states, so whatever is left of the open count is running without a person
  const running = Math.max(0, open - approvals - escalated - disputed);

  const segments = [
    { label: 'Running on its own', n: running, bar: 'bg-steel', dot: 'bg-steel' },
    { label: 'Awaiting approval', n: approvals, bar: 'bg-marigold', dot: 'bg-marigold' },
    { label: 'Escalated', n: escalated, bar: 'bg-crimson', dot: 'bg-crimson' },
    { label: 'Disputed', n: disputed, bar: 'bg-peri', dot: 'bg-peri' },
  ].filter((s) => s.n > 0);

  const ciKnown = rec ? Number.isFinite(rec.incremental.ciLow) : false;
  const tRate = (rec?.incremental.p1 ?? 0) * 100;
  const hRate = (rec?.incremental.p2 ?? 0) * 100;
  const railScale = Math.max(tRate, hRate, 1);

  return (
    <div>
      <PageHeader
        title="Command Center"
        lede="Where the money is, what the system is doing about it, and what it can prove."
      />

      <div className="grid gap-4 lg:grid-cols-5">
        {/* the money at stake, and who is holding it */}
        <Card className="animate-rise flex flex-col lg:col-span-3">
          <CardHeader>
            <CardTitle>Open revenue at risk</CardTitle>
            <Link
              to="/cases"
              className="ml-auto inline-flex items-center gap-1 text-2xs text-ash transition-colors ease-desk hover:text-ink"
            >
              Risk Queue <ArrowUpRight size={12} />
            </Link>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <div className="mb-7 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Money value={risk ? formatINR(risk.openExposurePaise) : '—'} size="xl" />
              <span className="tnum text-sm text-ash">across {open} open cases</span>
            </div>

            <div className="mt-auto flex h-2 gap-[3px] overflow-hidden rounded-full bg-ink/[0.055]">
              {segments.map((s) => (
                <span
                  key={s.label}
                  className={cn('h-full rounded-full transition-[flex-grow] duration-500 ease-desk', s.bar)}
                  style={{ flexGrow: s.n }}
                  title={`${s.label}: ${s.n}`}
                />
              ))}
            </div>

            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
              {segments.map((s) => (
                <li key={s.label} className="flex items-center gap-2 text-xs">
                  <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
                  <span className="text-ash">{s.label}</span>
                  <span className="tnum font-medium text-ink">{s.n}</span>
                </li>
              ))}
              {segments.length === 0 && <li className="text-xs text-ash">No open cases. The desk is clear.</li>}
            </ul>
          </CardContent>
        </Card>

        {/* the proof — this is the only number that survives a sceptic */}
        <Card className="animate-rise lg:col-span-2" style={{ animationDelay: '60ms' }}>
          <CardHeader>
            <CardTitle>Proven incremental</CardTitle>
            <Link
              to="/experiments"
              className="ml-auto inline-flex items-center gap-1 text-2xs text-ash transition-colors ease-desk hover:text-ink"
            >
              Experiments <ArrowUpRight size={12} />
            </Link>
          </CardHeader>
          <CardContent>
            <Money value={rec ? formatINR(rec.incrementalRecoveredPaiseEstimate) : '—'} size="lg" />
            <p className="mt-1 text-xs text-ash">
              recovered beyond what the untouched holdout got on its own
            </p>

            <div className="mt-5 space-y-2.5">
              <Rail label="Treatment" pct={tRate} scale={railScale} tone="bg-brass" />
              <Rail label="Holdout" pct={hRate} scale={railScale} tone="bg-peri" />
            </div>
            <p className="mt-3 border-t border-rule pt-3 text-2xs text-ash">
              {incrementalPct}pp lift
              {rec && ciKnown
                ? ` · 95% CI ${(rec.incremental.ciLow * 100).toFixed(1)} to ${(rec.incremental.ciHigh * 100).toFixed(1)}pp`
                : ' · confidence interval needs more cases'}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="animate-rise lg:col-span-3" style={{ animationDelay: '120ms' }}>
          <CardHeader>
            <CardTitle>What the ledger credited</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <LedgerRow label="Gross recovered, treatment" value={rec ? formatINR(rec.treatment.grossRecoveredPaise) : '—'} />
              <LedgerRow label="Credited — direct plus assisted" value={rec ? formatINR(rec.creditedRecoveredPaise) : '—'} />
              <LedgerRow label="Holdout baseline" value={rec ? formatINR(rec.holdout.baselineRecoveredPaise) : '—'} />
              <LedgerRow label="Recovery rate, treatment" value={`${treatRate}%`} />
            </dl>
            <p className="mt-3 max-w-[65ch] border-t border-rule pt-3 text-2xs leading-relaxed text-ash">
              A payment that arrived on its own is never credited to the system. Incremental is what the holdout
              says would not have arrived at all.
            </p>
          </CardContent>
        </Card>

        <Card className="animate-rise lg:col-span-2" style={{ animationDelay: '160ms' }}>
          <CardHeader>
            <CardTitle>Needs a person</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <LedgerRow label="Proposed actions to approve" value={String(approvals)} to="/approvals" />
              <LedgerRow label="Escalated — the pipeline stopped" value={String(escalated)} to="/approvals" />
              <LedgerRow label="Disputed — outreach frozen" value={String(disputed)} to="/approvals" />
            </dl>
            <p className="mt-3 border-t border-rule pt-3 text-2xs leading-relaxed text-ash">
              {approvals + escalated + disputed === 0
                ? 'Nothing is waiting on you. The desk runs itself until policy says otherwise.'
                : 'Each of these is blocked until someone decides. Nothing moves in the meantime.'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/*
        Reference, not a third data panel — so it reads as a footnote to the
        desk rather than a peer of the numbers above it. No elevation.
      */}
      <section
        className="animate-rise mt-4 rounded-panel border border-rule bg-panel/50 px-5 py-4"
        style={{ animationDelay: '200ms' }}
        aria-label="Legend"
      >
        <Eyebrow>Reading this desk</Eyebrow>
        <div className="mt-3.5 grid gap-x-10 gap-y-4 sm:grid-cols-3">
          <Legend rail="keyline-machine" title="Deterministic code" body="Amounts, invoice ids, policy verdicts and every value sent to a customer. No agent can write these." />
          <Legend rail="keyline-agent" title="An agent reasoned it" body="A diagnosis or a proposed action, always with a confidence reading. It is a proposal until policy allows it." />
          <Legend rail="keyline-holdout" title="Holdout" body="Ten percent of cases are randomly locked and never touched. They are the baseline every claim is measured against." />
        </div>
      </section>
    </div>
  );
}

function Rail({ label, pct, scale, tone }: { label: string; pct: number; scale: number; tone: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-2xs text-ash">{label}</span>
      <span className="relative block h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.055]">
        <span
          className={cn('absolute inset-0 origin-left rounded-full transition-transform duration-500 ease-desk', tone)}
          style={{ transform: `scaleX(${Math.min(1, pct / scale)})` }}
        />
      </span>
      <span className="tnum w-12 shrink-0 text-right text-2xs text-ink">{pct.toFixed(1)}%</span>
    </div>
  );
}

function LedgerRow({ label, value, to }: { label: string; value: string; to?: string }) {
  const inner = (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule/70 py-2.5 last:border-0">
      <dt className="text-sm text-ash">{label}</dt>
      <dd className="wide tnum text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
  return to ? (
    <Link to={to} className="block transition-colors ease-desk hover:text-ink [&_dt]:hover:text-ink">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function Legend({ rail, title, body }: { rail: string; title: string; body: string }) {
  return (
    <div className={cn('keyline', rail)}>
      <Eyebrow className="text-ink/80">{title}</Eyebrow>
      <p className="mt-1 text-2xs leading-relaxed text-ash">{body}</p>
    </div>
  );
}
