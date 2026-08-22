import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, formatINR } from '../lib/api';
import type { RecoveryReport, RevenueRisk } from '../lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/primitives';

export const Route = createFileRoute('/')({ component: CommandCenter });

function Stat({ title, value, sub, to }: { title: string; value: string; sub?: string; to: string }) {
  return (
    <Link to={to} className="block transition-transform hover:-translate-y-0.5">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold tabular-nums tracking-tight">{value}</div>
          {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
        </CardContent>
      </Card>
    </Link>
  );
}

function CommandCenter() {
  const { data: risk } = useQuery({ queryKey: ['revenue-risk'], queryFn: () => api<RevenueRisk>('/analytics/revenue-risk') });
  const { data: rec } = useQuery({ queryKey: ['recovery'], queryFn: () => api<RecoveryReport>('/analytics/recovery') });

  const incrementalPct = rec ? (rec.incremental.diff * 100).toFixed(1) : '…';
  const treatRate = rec && rec.treatment.cases > 0 ? ((rec.treatment.recovered / rec.treatment.cases) * 100).toFixed(1) : '0';

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold tracking-tight">Command Center</h1>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          title="Open revenue at risk"
          value={risk ? formatINR(risk.openExposurePaise) : '…'}
          sub={`${risk?.openCases ?? 0} open cases`}
          to="/cases"
        />
        <Stat
          title="Incremental recovered"
          value={rec ? formatINR(rec.incrementalRecoveredPaiseEstimate) : '…'}
          sub={`vs holdout · ${incrementalPct}pp lift`}
          to="/experiments"
        />
        <Stat
          title="Recovery rate (treatment)"
          value={`${treatRate}%`}
          sub={`${rec?.treatment.recovered ?? 0} of ${rec?.treatment.cases ?? 0} cases`}
          to="/experiments"
        />
        <Stat
          title="Awaiting a human"
          value={String((risk?.pendingApprovals ?? 0) + (risk?.escalated ?? 0))}
          sub={`${risk?.pendingApprovals ?? 0} to approve · ${risk?.escalated ?? 0} escalated · ${risk?.disputed ?? 0} disputed`}
          to="/approvals"
        />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recovered — gross vs credited</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Gross recovered (treatment)" value={rec ? formatINR(rec.treatment.grossRecoveredPaise) : '…'} />
            <Row label="Credited (direct + assisted)" value={rec ? formatINR(rec.creditedRecoveredPaise) : '…'} />
            <Row label="Holdout baseline recovered" value={rec ? formatINR(rec.holdout.baselineRecoveredPaise) : '…'} />
            <p className="pt-2 text-xs text-muted">
              External reconciliations are never credited. Incremental = what the holdout says would not have arrived on its own.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Escalated to humans" value={String(risk?.escalated ?? 0)} to="/approvals" />
            <Row label="Open disputes (all outreach frozen)" value={String(risk?.disputed ?? 0)} to="/cases" />
            <Row label="Awaiting approval" value={String(risk?.pendingApprovals ?? 0)} to="/approvals" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, to }: { label: string; value: string; to?: string }) {
  const inner = (
    <div className="flex items-center justify-between border-b border-border/60 pb-2 last:border-0">
      <span className="text-muted">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}
