import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { api, formatINR, timeAgo } from '../lib/api';
import type { CaseListRow } from '../lib/types';
import {
  Badge,
  CAUSE_LABELS,
  Chip,
  Empty,
  Meter,
  STATE_LABELS,
  STATE_TONES,
  Tooltip,
} from '../components/ui/primitives';
import { cn } from '../lib/cn';

export const Route = createFileRoute('/cases/')({ component: RiskQueue });

const col = createColumnHelper<CaseListRow>();

const columns = [
  col.accessor('customerName', {
    header: 'Customer',
    cell: (info) => (
      <div className="min-w-40">
        <Link
          to="/cases/$caseId"
          params={{ caseId: info.row.original.id }}
          className="font-medium text-ink decoration-brass/50 underline-offset-4 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {info.getValue()}
        </Link>
        <div className="mt-0.5 truncate text-2xs text-ash">{info.row.original.customerEmail}</div>
      </div>
    ),
  }),
  col.accessor('exposurePaise', {
    header: () => <span className="block text-right">Exposure</span>,
    cell: (info) => (
      <span className="wide tnum block text-right text-sm font-semibold text-brass">{formatINR(info.getValue())}</span>
    ),
  }),
  col.accessor('causeHypothesis', {
    header: 'Diagnosis',
    cell: (info) => {
      const cause = info.getValue();
      return cause ? (
        <Badge tone="blue">{CAUSE_LABELS[cause] ?? cause}</Badge>
      ) : (
        <span className="text-2xs text-ash">not yet diagnosed</span>
      );
    },
  }),
  col.accessor('causeConfidence', {
    header: 'Confidence',
    cell: (info) => {
      const v = info.getValue();
      return v ? <Meter value={Number(v)} /> : <span className="text-2xs text-ash">—</span>;
    },
  }),
  col.accessor('nextAction', {
    header: 'Next action',
    cell: (info) => (info.getValue() ? <Chip>{info.getValue()}</Chip> : <span className="text-2xs text-ash">—</span>),
  }),
  col.accessor('state', {
    header: 'State',
    cell: (info) => (
      <Badge tone={STATE_TONES[info.getValue()] ?? 'neutral'}>
        {STATE_LABELS[info.getValue()] ?? info.getValue()}
      </Badge>
    ),
  }),
  col.accessor('holdoutArm', {
    header: 'Arm',
    cell: (info) =>
      info.getValue() === 'holdout' ? (
        <Tooltip label="Holdout case: randomly assigned to the 10% observe-only control. No intervention will ever execute; its outcome measures what would have happened anyway.">
          <Badge tone="violet" className="cursor-help">
            <Lock size={9} /> holdout
          </Badge>
        </Tooltip>
      ) : (
        <span className="text-2xs text-ash">treatment</span>
      ),
  }),
  col.accessor('openedAt', {
    header: () => <span className="block text-right">Opened</span>,
    cell: (info) => <span className="block text-right text-2xs text-ash">{timeAgo(info.getValue())}</span>,
  }),
];

const STATE_FILTERS = ['all', 'open', 'pending_approval', 'escalated', 'disputed', 'waiting', 'recovered', 'stopped', 'lost'] as const;

const FILTER_LABELS: Record<(typeof STATE_FILTERS)[number], string> = {
  all: 'All',
  open: 'Open',
  pending_approval: 'Awaiting approval',
  escalated: 'Escalated',
  disputed: 'Disputed',
  waiting: 'Waiting',
  recovered: 'Recovered',
  stopped: 'Stopped',
  lost: 'Lost',
};

const EMPTY_HINTS: Record<string, string> = {
  open: 'Cases appear the moment a subscription payment fails or an invoice runs past its due date.',
  pending_approval: 'Nothing is waiting on a decision. Small-exposure actions are approved automatically by policy.',
  escalated: 'The pipeline has not handed anything over.',
  disputed: 'No customer has formally contested a charge.',
  recovered: 'Nothing has been recovered yet.',
};

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
  const exposed = rows.reduce((sum, r) => sum + r.exposurePaise, 0);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <h1 className="widest text-[1.35rem] font-semibold leading-none tracking-tight text-ink">Risk Queue</h1>
          <p className="mt-2 text-sm text-ash">
            Ranked by exposure. <span className="wide tnum font-medium text-brass">{formatINR(exposed)}</span> across{' '}
            <span className="tnum text-ink">{rows.length}</span> {rows.length === 1 ? 'case' : 'cases'} in this view.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-1 rounded-md border border-rule bg-panel p-1">
          {STATE_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-2.5 py-1 text-2xs transition-colors ease-desk',
                f === filter ? 'bg-brass/15 font-semibold text-brass' : 'text-ash hover:bg-ink/[0.05] hover:text-ink',
              )}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-panel border border-rule bg-panel shadow-panel max-lg:overflow-x-auto">
        <table className="w-full text-sm max-lg:min-w-[68rem]">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-rule">
                {hg.headers.map((h) => (
                  <th key={h.id} className="eyebrow px-4 py-3 text-left">
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
                className="group cursor-pointer border-b border-rule/60 transition-colors ease-desk last:border-0 hover:bg-ink/[0.038]"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length}>
                  <Empty
                    title={`Nothing in ${FILTER_LABELS[filter].toLowerCase()}.`}
                    hint={EMPTY_HINTS[filter] ?? 'Try another view.'}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-2xs text-ash">
        Holdout cases are action-locked by policy — they are listed so you can see them, never so you can act on them.
      </p>
    </div>
  );
}
