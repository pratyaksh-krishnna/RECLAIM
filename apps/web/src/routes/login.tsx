import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { api, setToken, setUser } from '../lib/api';
import { Button, Card, CardContent } from '../components/ui/primitives';

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
      setError('Invalid credentials');
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-sm">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">RECLAIM</h1>
      <p className="mb-6 text-sm text-muted">Revenue recovery command center</p>
      <Card>
        <CardContent className="pt-4">
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Email</span>
              <input className="w-full rounded-md border border-border px-3 py-2 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Password</span>
              <input type="password" className="w-full rounded-md border border-border px-3 py-2 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <p className="text-sm text-bad">{error}</p>}
            <Button type="submit" className="w-full">Sign in</Button>
            <p className="text-xs text-muted">demo users: admin / operator / viewer @reclaim.test · password “reclaim-demo”</p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
