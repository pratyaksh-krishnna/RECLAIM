import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ErrorBar, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { api, formatINR } from '../lib/api';
import type { InterventionStat, RecoveryReport } from '../lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/primitives';

export const Route = createFileRoute('/experiments')({ component: Experiments });

function Experiments() {
  const { data: rec } = useQuery({ queryKey: ['recovery'], queryFn: () => api<RecoveryReport>('/analytics/recovery') });
  const { data: stats = [] } = useQuery({ queryKey: ['intervention-stats'], queryFn: () => api<InterventionStat[]>('/analytics/interventions') });

  if (!rec) return <p className="text-muted">Loading…</p>;
  const { incremental } = rec;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const chart = [
    { arm: 'Treatment', rate: incremental.p1 * 100, n: incremental.n1 },
    { arm: 'Holdout', rate: incremental.p2 * 100, n: incremental.n2 },
  ];
  const ciKnown = Number.isFinite(incremental.ciLow);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold tracking-tight">Experiments — treatment vs holdout</h1>

      <Card>
        <CardHeader><CardTitle>Conclusion</CardTitle></CardHeader>
        <CardContent className="text-sm leading-relaxed">
          <p>
            Gross recovered <strong className="tabular-nums">{formatINR(rec.treatment.grossRecoveredPaise)}</strong> across{' '}
            {rec.treatment.cases} treatment cases. The holdout ({rec.holdout.cases} untouched cases) recovered at{' '}
            <strong className="tabular-nums">{pct(incremental.p2)}</strong> on its own — meaning roughly{' '}
            <strong className="tabular-nums">{formatINR(rec.treatment.grossRecoveredPaise - rec.incrementalRecoveredPaiseEstimate)}</strong>{' '}
            would likely have arrived anyway. <strong>Incremental recovery ≈ {formatINR(rec.incrementalRecoveredPaiseEstimate)}</strong>{' '}
            ({pct(incremental.diff)} rate lift{ciKnown ? `, 95% CI ${pct(incremental.ciLow)} to ${pct(incremental.ciHigh)}` : ''}).
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Recovery rate by arm</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chart} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(217 20% 90%)" />
                <XAxis dataKey="arm" tick={{ fontSize: 12 }} />
                <YAxis unit="%" tick={{ fontSize: 12 }} />
                <ChartTooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                <Bar dataKey="rate" fill="hsl(226 64% 45%)" radius={[4, 4, 0, 0]} barSize={64}>
                  {ciKnown && <ErrorBar dataKey={() => [0, 0]} width={0} />}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs text-muted">n = {incremental.n1} treatment · {incremental.n2} holdout</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Per-action performance</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr>
                  <th className="py-1.5">Action</th>
                  <th className="py-1.5 text-right">Proposed</th>
                  <th className="py-1.5 text-right">Executed</th>
                  <th className="py-1.5 text-right">Cases recovered after</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.actionType} className="border-t border-border/50">
                    <td className="py-1.5"><code className="rounded bg-black/5 px-1.5 py-0.5 text-xs">{s.actionType}</code></td>
                    <td className="py-1.5 text-right tabular-nums">{s.proposed}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.executed}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.casesRecoveredAfter}</td>
                  </tr>
                ))}
                {stats.length === 0 && (
                  <tr><td colSpan={4} className="py-6 text-center text-muted">No interventions yet.</td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted">
        Attribution: direct = paid through our link/mandate execution · assisted = paid another way after our contact, inside the window · external = never credited. Holdout outcomes form the baseline.
      </p>
    </div>
  );
}
