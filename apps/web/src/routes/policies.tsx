import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getUser } from '../lib/api';
import type { PolicyVersionRow } from '../lib/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Eyebrow,
  PageHeader,
} from '../components/ui/primitives';
import { cn } from '../lib/cn';

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
      <PageHeader
        title="Policy Studio"
        lede="The rules that decide what may be sent, to whom, and how often. Every proposal — from an agent or a person — is checked against the active version."
      >
        {active && <Badge tone="brass">running v{active.version}</Badge>}
      </PageHeader>

      <div className="grid items-start gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="keyline keyline-machine">
          <CardHeader>
            <CardTitle>Active configuration</CardTitle>
            {draft !== null && <span className="eyebrow ml-auto text-marigold">unsaved draft</span>}
          </CardHeader>
          <CardContent>
            <textarea
              className="h-[30rem] w-full resize-y rounded-md border border-rule bg-paper/70 p-4 font-mono text-xs leading-relaxed text-ink/90 focus:border-brass/40"
              value={draftValue}
              readOnly={!isAdmin}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
            {isAdmin ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  className="h-9 min-w-56 flex-1 rounded-md border border-rule bg-paper/60 px-3 text-sm text-ink placeholder:text-ash/60"
                  placeholder="What changed, and why"
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
                  Save as a new version
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-2xs text-ash">
                You are signed in as a {getUser()?.role ?? 'viewer'}. Only an admin can change policy.
              </p>
            )}
            {error && (
              <p className="mt-3 rounded-md border border-crimson/30 bg-crimson/10 px-3 py-2 font-mono text-2xs text-crimson">
                {error}
              </p>
            )}
            <p className="mt-3 border-t border-rule pt-3 text-2xs leading-relaxed text-ash">
              Versions are immutable. Saving publishes a new one and leaves the old one on the record, so every past
              verdict can still be explained by the version that produced it.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Version history</CardTitle>
            <span className="tnum ml-auto text-2xs text-ash">{data.length}</span>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.length === 0 && <p className="text-sm text-ash">No versions yet.</p>}
            {data.map((p) => (
              <div
                key={p.id}
                className={cn(
                  'keyline rounded-md border border-rule p-3 text-sm',
                  p.active ? 'keyline-machine bg-ink/[0.032]' : 'keyline-quiet',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="wide tnum font-semibold text-ink">v{p.version}</span>
                  {p.active && <Badge tone="green">active</Badge>}
                  <button
                    className="ml-auto text-2xs text-ash transition-colors ease-desk hover:text-brass"
                    onClick={() => setDiffAgainst(diffAgainst === p.version ? null : p.version)}
                  >
                    {diffAgainst === p.version ? 'hide diff' : 'diff vs active'}
                  </button>
                </div>
                {p.comment && <p className="mt-1 text-xs text-ash">{p.comment}</p>}
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
  if (changed.length === 0) return <p className="mt-2 text-2xs text-ash">Identical to the active version.</p>;
  return (
    <div className="mt-3 border-t border-rule pt-2">
      <Eyebrow>
        {changed.length} {changed.length === 1 ? 'difference' : 'differences'}
      </Eyebrow>
      <table className="mt-2 w-full font-mono text-2xs">
        <tbody>
          {changed.map((k) => (
            <tr key={k} className="border-b border-rule/50 last:border-0">
              <td className="py-1.5 pr-2 text-ink/80">{k}</td>
              <td className="py-1.5 pr-2 text-right text-crimson line-through">{fa[k] ?? '∅'}</td>
              <td className="py-1.5 pl-2 text-right text-sage">{fb[k] ?? '∅'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
