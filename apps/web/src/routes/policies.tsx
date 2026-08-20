import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getUser } from '../lib/api';
import type { PolicyVersionRow } from '../lib/types';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '../components/ui/primitives';

export const Route = createFileRoute('/policies')({ component: PolicyStudio });

function PolicyStudio() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['policies'], queryFn: () => api<PolicyVersionRow[]>('/policies'), refetchInterval: false });
  const isAdmin = getUser()?.role === 'admin';
  const active = data.find((p) => p.active);
  const [draft, setDraft] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [diffAgainst, setDiffAgainst] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: (body: { config: unknown; comment: string }) => api('/policies', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setDraft(null);
      setComment('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['policies'] });
    },
    onError: (e) => setError(String(e)),
  });

  const draftValue = draft ?? (active ? JSON.stringify(active.config, null, 2) : '');
  const compare = data.find((p) => p.version === diffAgainst);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold tracking-tight">Policy Studio</h1>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Active config {active ? `(v${active.version})` : ''}</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              className="h-96 w-full rounded-md border border-border bg-surface p-3 font-mono text-xs"
              value={draftValue}
              readOnly={!isAdmin}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
            {isAdmin && (
              <div className="mt-2 flex gap-2">
                <input
                  className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm"
                  placeholder="change comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={save.isPending || draft === null}
                  onClick={() => {
                    try {
                      save.mutate({ config: JSON.parse(draftValue), comment });
                    } catch {
                      setError('invalid JSON');
                    }
                  }}
                >
                  Save as new version
                </Button>
              </div>
            )}
            {error && <p className="mt-2 text-sm text-bad">{error}</p>}
            {!isAdmin && <p className="mt-2 text-xs text-muted">Sign in as admin to edit. Every save creates a new immutable version.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Version history</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.map((p) => (
              <div key={p.id} className="rounded-md border border-border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">v{p.version}</span>
                  {p.active && <Badge tone="green">active</Badge>}
                  <span className="text-muted">{p.comment ?? ''}</span>
                  <button className="ml-auto text-xs text-accent hover:underline" onClick={() => setDiffAgainst(diffAgainst === p.version ? null : p.version)}>
                    {diffAgainst === p.version ? 'hide diff' : 'diff vs active'}
                  </button>
                </div>
                {diffAgainst === p.version && active && compare && <ConfigDiff a={compare.config} b={active.config} />}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = JSON.stringify(v);
  }
  return out;
}

function ConfigDiff({ a, b }: { a: Record<string, unknown>; b: Record<string, unknown> }) {
  const fa = flatten(a);
  const fb = flatten(b);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  const changed = keys.filter((k) => fa[k] !== fb[k]);
  if (changed.length === 0) return <p className="mt-2 text-xs text-muted">identical to active</p>;
  return (
    <table className="mt-2 w-full font-mono text-xs">
      <tbody>
        {changed.map((k) => (
          <tr key={k} className="border-t border-border/40">
            <td className="py-1 pr-2">{k}</td>
            <td className="py-1 pr-2 text-bad line-through">{fa[k] ?? '∅'}</td>
            <td className="py-1 text-good">{fb[k] ?? '∅'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
