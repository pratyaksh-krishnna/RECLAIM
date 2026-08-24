import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { api, formatINR } from '../lib/api';
import type { InterventionStat, RecoveryReport } from '../lib/types';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chip,
  Empty,
  Eyebrow,
  Loading,
  PageHeader,
} from '../components/ui/primitives';
import { cn } from '../lib/cn';

export const Route = createFileRoute('/experiments')({ component: Experiments });

/*
 * Chart fills, deliberately lighter than the text tokens. Brass is tuned to
 * carry 4.5:1 as a numeral; the same value spread across a bar reads as mud.
 * A fill only has to stay distinguishable, so both hues open up here.
 */
const BRASS = 'hsl(38 68% 52%)';
const PERI = 'hsl(244 54% 68%)';

function Experiments() {
  const { data: rec } = useQuery({ queryKey: ['recovery'], queryFn: () => api<RecoveryReport>('/analytics/recovery') });
  const { data: stats = [] } = useQuery({ queryKey: ['intervention-stats'], queryFn: () => api<InterventionStat[]>('/analytics/interventions') });

  if (!rec) return <Loading />;
  const { incremental } = rec;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const chart = [
    { arm: 'Treatment', rate: incremental.p1 * 100, n: incremental.n1 },
    { arm: 'Holdout', rate: incremental.p2 * 100, n: incremental.n2 },
  ];
  const ciKnown = Number.isFinite(incremental.ciLow);
  const conclusive = ciKnown && incremental.ciLow > 0;

  return (
    <div>
      <PageHeader
        title="Experiments"
        lede="One case in ten is randomly locked and never touched. Everything this desk claims is measured against those."
      />

      {/* the verdict, stated plainly */}
      <Card className="keyline keyline-machine">
        <CardHeader>
          <CardTitle>The verdict</CardTitle>
          <span className="ml-auto">
            <span
              className={cn(
                'eyebrow',
                conclusive ? 'text-sage' : ciKnown ? 'text-marigold' : 'text-ash',
              )}
            >
              {conclusive ? 'holds up' : ciKnown ? 'not yet conclusive' : rec.holdout.cases === 0 ? 'no baseline yet' : 'too few cases'}
            </span>
          </span>
        </CardHeader>
        <CardContent>
          {rec.holdout.cases === 0 ? (
            <p className="max-w-[65ch] text-[0.95rem] leading-relaxed text-ink/90">
              Treatment recovered <Num>{formatINR(rec.treatment.grossRecoveredPaise)}</Num> across{' '}
              <Num>{rec.treatment.cases}</Num> cases. No holdout case has been assigned yet, so there is nothing to
              subtract — that figure is gross, not proven. The claim only becomes measurable once the control arm
              starts filling.
            </p>
          ) : (
            <p className="max-w-[65ch] text-[0.95rem] leading-relaxed text-ink/90">
              Treatment recovered <Num>{formatINR(rec.treatment.grossRecoveredPaise)}</Num> across{' '}
              <Num>{rec.treatment.cases}</Num> cases. The <Num>{rec.holdout.cases}</Num> untouched holdout cases
              recovered at <Num>{pct(incremental.p2)}</Num> with no help at all, so roughly{' '}
              <Num>{formatINR(rec.treatment.grossRecoveredPaise - rec.incrementalRecoveredPaiseEstimate)}</Num> would
              have arrived anyway. What the system actually added is{' '}
              <Num>{formatINR(rec.incrementalRecoveredPaiseEstimate)}</Num>.
            </p>
          )}

          {ciKnown && (
            <div className="mt-6 max-w-xl">
              <Eyebrow>Rate lift, with its 95% interval</Eyebrow>
              <ConfidenceRuler low={incremental.ciLow * 100} high={incremental.ciHigh * 100} point={incremental.diff * 100} />
              <p className="mt-2.5 text-2xs leading-relaxed text-ash">
                {conclusive
                  ? 'The whole interval sits above zero, so the lift is not chance.'
                  : 'The interval still crosses zero. More cases are needed before the lift can be called real.'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recovery rate by arm</CardTitle>
            <span className="tnum ml-auto text-2xs text-ash">
              n = {incremental.n1} treatment · {incremental.n2} holdout
            </span>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chart} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="hsl(228 20% 87%)" vertical={false} />
                <XAxis
                  dataKey="arm"
                  tick={{ fontSize: 11, fill: 'hsl(226 13% 45%)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'hsl(228 20% 87%)' }}
                />
                <YAxis
                  unit="%"
                  tick={{ fontSize: 11, fill: 'hsl(226 13% 45%)' }}
                  tickLine={false}
                  axisLine={false}
                />
                <ChartTooltip
                  cursor={{ fill: 'hsl(228 30% 95% / 0.7)' }}
                  contentStyle={{
                    background: 'hsl(0 0% 100%)',
                    border: '1px solid hsl(228 20% 87%)',
                    borderRadius: 8,
                    boxShadow: '0 8px 24px -12px hsl(228 25% 30% / 0.25)',
                    fontSize: 12,
                    color: 'hsl(226 42% 15%)',
                  }}
                  labelStyle={{ color: 'hsl(226 13% 45%)' }}
                  formatter={(v: number) => [`${v.toFixed(1)}%`, 'recovered']}
                />
                <Bar dataKey="rate" radius={[3, 3, 0, 0]} barSize={72} isAnimationActive={false}>
                  {chart.map((d) => (
                    <Cell key={d.arm} fill={d.arm === 'Treatment' ? BRASS : PERI} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How each action performed</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule">
                  <th className="eyebrow py-2 text-left">Action</th>
                  <th className="eyebrow py-2 text-right">Proposed</th>
                  <th className="eyebrow py-2 text-right">Executed</th>
                  <th className="eyebrow py-2 text-right">Recovered after</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.actionType} className="border-b border-rule/60 last:border-0">
                    <td className="py-2.5">
                      <Chip>{s.actionType}</Chip>
                    </td>
                    <td className="tnum py-2.5 text-right text-ash">{s.proposed}</td>
                    <td className="tnum py-2.5 text-right text-ink">{s.executed}</td>
                    <td className="tnum py-2.5 text-right font-semibold text-sage">{s.casesRecoveredAfter}</td>
                  </tr>
                ))}
                {stats.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <Empty title="No action has run yet." hint="Once the desk starts intervening, each action's record shows up here." />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Rule term="Direct" body="Paid through a link or mandate this system executed. Credited." />
        <Rule term="Assisted" body="Paid another way after we made contact, inside the attribution window. Credited." />
        <Rule term="External" body="Paid with no involvement from us. Never credited, no matter the timing." />
      </div>
    </div>
  );
}

function Num({ children }: { children: React.ReactNode }) {
  return <span className="wide tnum font-semibold text-brass">{children}</span>;
}

function Rule({ term, body }: { term: string; body: string }) {
  return (
    <div className="keyline keyline-quiet">
      <Eyebrow className="text-ink/80">{term}</Eyebrow>
      <p className="mt-1 text-2xs leading-relaxed text-ash">{body}</p>
    </div>
  );
}

/**
 * The interval, drawn against zero. A lift only counts when the whole bar sits
 * to the right of the zero tick, so the reader can see the claim survive rather
 * than take a number's word for it.
 */
function ConfidenceRuler({ low, high, point }: { low: number; high: number; point: number }) {
  const min = Math.min(low, 0);
  const max = Math.max(high, 0);
  const span = max - min || 1;
  const at = (v: number) => ((v - min) / span) * 100;
  const crossesZero = low <= 0;

  return (
    <div className="mt-3">
      <div className="relative h-9">
        {/* zero tick */}
        <span className="absolute bottom-0 top-0 w-px bg-ash/50" style={{ left: `${at(0)}%` }} aria-hidden />
        {/* the interval */}
        <span
          className={cn(
            'absolute top-[14px] h-2 rounded-full',
            crossesZero ? 'bg-marigold/45' : 'bg-sage/40',
          )}
          style={{ left: `${at(low)}%`, width: `${Math.max(0.5, at(high) - at(low))}%` }}
        />
        {/* the point estimate */}
        <span
          className={cn(
            'absolute top-[10px] h-4 w-[3px] -translate-x-1/2 rounded-full',
            crossesZero ? 'bg-marigold' : 'bg-sage',
          )}
          style={{ left: `${at(point)}%` }}
        />
      </div>
      <div className="tnum flex justify-between font-mono text-2xs text-ash">
        <span>{low.toFixed(1)}pp</span>
        <span className={cn('font-semibold', crossesZero ? 'text-marigold' : 'text-sage')}>
          {point > 0 ? '+' : ''}
          {point.toFixed(1)}pp
        </span>
        <span>{high.toFixed(1)}pp</span>
      </div>
    </div>
  );
}
