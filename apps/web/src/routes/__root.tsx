import { Link, Outlet, createRootRoute, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { IndianRupee, LogOut } from 'lucide-react';
import { api, getToken, getUser, setToken, setUser } from '../lib/api';
import type { RevenueRisk } from '../lib/types';
import { cn } from '../lib/cn';

export const Route = createRootRoute({ component: RootLayout });

const NAV = [
  { to: '/', label: 'Command Center' },
  { to: '/cases', label: 'Risk Queue' },
  { to: '/approvals', label: 'Human Inbox' },
  { to: '/policies', label: 'Policy Studio' },
  { to: '/experiments', label: 'Experiments' },
] as const;

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const authed = Boolean(getToken());
  const user = getUser();
  const { data: risk } = useQuery({
    queryKey: ['revenue-risk-nav'],
    queryFn: () => api<RevenueRisk>('/analytics/revenue-risk'),
    enabled: authed,
  });
  // the inbox holds both kinds of human work, so the badge must count both —
  // counting only approvals hid escalated cases from the operator entirely
  const awaitingHuman = (risk?.pendingApprovals ?? 0) + (risk?.escalated ?? 0);

  if (!authed && pathname !== '/login') {
    location.assign('/login');
    return null;
  }

  return (
    <div className="min-h-screen">
      {pathname !== '/login' && (
        <header className="sticky top-0 z-10 border-b border-border bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
            <Link to="/" className="flex items-center gap-2 font-bold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white">
                <IndianRupee size={16} />
              </span>
              RECLAIM
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-muted hover:bg-black/5 hover:text-ink',
                    (pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to))) && 'bg-accent/10 font-medium text-accent',
                  )}
                >
                  {item.label}
                  {item.to === '/approvals' && awaitingHuman > 0 && (
                    <span className="ml-1.5 rounded-full bg-warn px-1.5 text-xs font-semibold text-white">{awaitingHuman}</span>
                  )}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm text-muted">
              {user && (
                <span>
                  {user.name} · <span className="uppercase text-xs font-semibold">{user.role}</span>
                </span>
              )}
              <button
                className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-black/5"
                onClick={() => {
                  setToken(null);
                  setUser(null);
                  location.assign('/login');
                }}
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </header>
      )}
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
