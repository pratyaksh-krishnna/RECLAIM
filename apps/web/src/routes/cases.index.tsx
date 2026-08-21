import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { api, formatINR, timeAgo } from '../lib/api';
import type { CaseListRow } from '../lib/types';
import { Badge, CAUSE_LABELS, STATE_TONES, Tooltip } from '../components/ui/primitives';
import { cn } from '../lib/cn';

export const Route = createFileRoute('/cases/')({ component: RiskQueue });

const col = createColumnHelper<CaseListRow>();

const columns = [
  col.accessor('customerName', {
    header: 'Customer',
    cell: (info) => (
      <div>
        <Link
          to="/cases/$caseId"
          params={{ caseId: info.row.original.id }}
          className="font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {info.getValue()}
        </Link>
        <div className="text-xs text-muted">{info.row.original.customerEmail}</div>
      </div>
    ),
  }),
  col.accessor('exposurePaise', {
    header: () => <span className="block text-right">Exposure</span>,
    cell: (info) => <span className="block text-right font-semibold tabular-nums">{formatINR(info.getValue())}</span>,
  }),
  col.accessor('causeHypothesis', {
    header: 'Cause',
    cell: (info) => {
      const cause = info.getValue();
      return cause ? <Badge tone="blue">{CAUSE_LABELS[cause] ?? cause}</Badge> : <span className="text-xs text-muted">—</span>;
    },
  }),
  col.accessor('causeConfidence', {
    header: 'Conf.',
    cell: (info) => {
      const v = info.getValue();
      return v ? <span className="tabular-nums text-sm">{Math.round(Number(v) * 100)}%</span> : '—';
    },
  }),
  col.accessor('nextAction', {
    header: 'Next action',
    cell: (info) => (info.getValue() ? <code className="rounded bg-black/5 px-1.5 py-0.5 text-xs">{info.getValue()}</code> : <span className="text-xs text-muted">—</span>),
  }),
  col.accessor('state', {
    header: 'State',
    cell: (info) => <Badge tone={STATE_TONES[info.getValue()] ?? 'neutral'}>{info.getValue()}</Badge>,
  }),
  col.accessor('holdoutArm', {
    header: 'Arm',
    cell: (info) =>
      info.getValue() === 'holdout' ? (
        <Tooltip label="Holdout case: randomly assigned to the 10% observe-only control. No intervention will ever execute; its outcome measures what would have happened anyway.">
          <Badge tone="violet" className="cursor-help">
            <Lock size={10} className="mr-1" /> holdout
          </Badge>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted">treatment</span>
      ),
  }),
  col.accessor('openedAt', {
    header: 'Opened',
    cell: (info) => <span className="text-xs text-muted">{timeAgo(info.getValue())}</span>,
  }),
];

const STATE_FILTERS = ['all', 'open', 'pending_approval', 'escalated', 'disputed', 'waiting', 'recovered', 'stopped', 'lost'] as const;

/**
 * Stable empty fallback. An inline `data = []` default creates a NEW array
 * reference every render; while a freshly-keyed query is still loading,
 * useReactTable sees perpetually-changing data and re-renders forever,
 * freezing the tab. The fallback must be referentially stable.
 */
const EMPTY_ROWS: CaseListRow[] = [];

function RiskQueue() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<(typeof STATE_FILTERS)[number]>('open');
  const query =
    filter === 'all' ? '' : filter === 'open' ? '?open=true' : `?state=${filter}`;
  const { data } = useQuery({
    queryKey: ['cases', filter],
    queryFn: () => api<CaseListRow[]>(`/recovery/cases${query}`),
  });
  const rows = data ?? EMPTY_ROWS;

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Risk Queue</h1>
        <div className="flex gap-1">
          {STATE_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn('rounded-md px-2.5 py-1 text-xs text-muted hover:bg-black/5', f === filter && 'bg-accent/10 font-semibold text-accent')}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface text-left text-xs uppercase tracking-wide text-muted">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} className="px-3 py-2.5 font-medium">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => navigate({ to: '/cases/$caseId', params: { caseId: row.original.id } })}
                className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-surface"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-muted">
                  No cases match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">Ranked by exposure (amount due). Holdout cases are action-locked by policy.</p>
    </div>
  );
}
