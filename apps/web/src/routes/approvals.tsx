import { Link, createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatINR, getUser, timeAgo } from '../lib/api';
import type { ApprovalRow } from '../lib/types';
import { Badge, Button, CAUSE_LABELS, Card, CardContent } from '../components/ui/primitives';

export const Route = createFileRoute('/approvals')({ component: Approvals });

function Approvals() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['approvals'], queryFn: () => api<ApprovalRow[]>('/approvals') });
  const canAct = getUser()?.role !== 'viewer';
  const decide = useMutation({
    mutationFn: (args: { caseId: string; interventionId: string; decision: 'approve' | 'deny' }) =>
      api(`/recovery/cases/${args.caseId}/approve`, { method: 'POST', body: JSON.stringify({ interventionId: args.interventionId, decision: args.decision }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['revenue-risk-nav'] });
    },
  });

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold tracking-tight">Approvals</h1>
      {data.length === 0 && (
        <Card><CardContent className="py-10 text-center text-muted">Nothing awaiting approval.</CardContent></Card>
      )}
      <div className="space-y-3">
        {data.map((row) => (
          <Card key={row.intervention.id}>
            <CardContent className="flex flex-wrap items-center gap-3 pt-4">
              <div className="min-w-48">
                <Link to="/cases/$caseId" params={{ caseId: row.caseRow.id }} className="font-medium hover:underline">
                  {row.customerName}
                </Link>
                <div className="text-xs text-muted">
                  {row.caseRow.causeHypothesis ? CAUSE_LABELS[row.caseRow.causeHypothesis] ?? row.caseRow.causeHypothesis : 'undiagnosed'}
                </div>
              </div>
              <div className="font-semibold tabular-nums">{formatINR(row.caseRow.exposurePaise)}</div>
              <code className="rounded bg-black/5 px-1.5 py-0.5 text-xs">{row.intervention.actionType}</code>
              {row.intervention.confidence && <Badge tone="blue">{Math.round(Number(row.intervention.confidence) * 100)}% conf</Badge>}
              <span className="max-w-md text-sm text-muted">{row.intervention.rationale}</span>
              <span className="text-xs text-muted">{timeAgo(row.intervention.createdAt)}</span>
              {canAct && (
                <div className="ml-auto flex gap-2">
                  <Button variant="success" size="sm" onClick={() => decide.mutate({ caseId: row.caseRow.id, interventionId: row.intervention.id, decision: 'approve' })}>
                    Approve
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => decide.mutate({ caseId: row.caseRow.id, interventionId: row.intervention.id, decision: 'deny' })}>
                    Deny
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
