import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { IndianRupee } from 'lucide-react';
import { api, setToken, setUser } from '../lib/api';
import { Button, Eyebrow } from '../components/ui/primitives';

export const Route = createFileRoute('/login')({ component: LoginPage });

function LoginPage() {
  const [email, setEmail] = useState('operator@reclaim.test');
  const [password, setPassword] = useState('reclaim-demo');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ token: string; user: unknown }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setToken(res.token);
      setUser(res.user);
      location.assign('/');
    } catch {
      setError('That email and password do not match an account.');
    }
  }

  return (
    <div className="min-h-[100dvh] lg:grid lg:grid-cols-2">
      {/* the thesis, stated once */}
      <div className="flex flex-col justify-between border-b border-rule px-8 py-10 lg:border-b-0 lg:border-r lg:px-12 lg:py-14">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded border border-brass/40 bg-brass/10 text-brass">
            <IndianRupee size={15} strokeWidth={2.4} />
          </span>
          <span className="widest text-sm font-bold tracking-[0.12em] text-ink">RECLAIM</span>
        </div>

        <div className="my-12 max-w-lg lg:my-0">
          <h1 className="widest text-[2.1rem] font-semibold leading-[1.15] tracking-tight text-ink">
            Agents reason about recovery.
            <br />
            <span className="text-brass">Code controls the money.</span>
          </h1>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-ash">
            Failed payments and overdue invoices are diagnosed, worked and closed on their own — inside limits no
            model can move. Every rupee claimed is measured against a tenth of cases nobody ever touched.
          </p>
        </div>

        <dl className="grid max-w-lg grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          <Claim term="No agent writes an amount" body="Every figure sent to a customer is injected by the server from the ledger." />
          <Claim term="One policy gate" body="Agent proposals and human ones are checked by the same deterministic rules." />
          <Claim term="A 10% holdout" body="Randomly assigned, never contacted, and the baseline for every claim." />
        </dl>
      </div>

      {/* the door */}
      <div className="flex items-center px-8 py-14 lg:px-12">
        <form onSubmit={submit} className="w-full max-w-sm">
          <Eyebrow>Sign in</Eyebrow>
          <h2 className="wide mt-2 text-xl font-semibold text-ink">Open the desk</h2>

          <div className="mt-7 space-y-4">
            <label className="block">
              <span className="eyebrow">Email</span>
              <input
                className="mt-1.5 h-10 w-full rounded-md border border-rule bg-panel px-3 text-sm text-ink transition-colors ease-desk placeholder:text-ash/60 hover:border-ash/40 focus:border-brass/50"
                type="email"
                required
                value={email}
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="eyebrow">Password</span>
              <input
                type="password"
                required
                minLength={6}
                className="mt-1.5 h-10 w-full rounded-md border border-rule bg-panel px-3 text-sm text-ink transition-colors ease-desk placeholder:text-ash/60 hover:border-ash/40 focus:border-brass/50"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {error && (
              <p className="rounded-md border border-crimson/30 bg-crimson/10 px-3 py-2 text-xs text-crimson">{error}</p>
            )}

            <Button type="submit" className="h-10 w-full">
              Sign in
            </Button>
          </div>

          <div className="mt-7 border-t border-rule pt-4">
            <Eyebrow>Demo accounts</Eyebrow>
            <p className="mt-2 font-mono text-2xs leading-relaxed text-ash">
              admin@reclaim.test · operator@reclaim.test · viewer@reclaim.test
              <br />
              password: reclaim-demo
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}

function Claim({ term, body }: { term: string; body: string }) {
  return (
    <div className="keyline keyline-machine">
      <dt className="text-2xs font-semibold leading-snug text-ink/85">{term}</dt>
      <dd className="mt-1 text-2xs leading-relaxed text-ash">{body}</dd>
    </div>
  );
}
