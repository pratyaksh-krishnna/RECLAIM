import { Link, Outlet, createRootRoute, useRouterState } from '@tanstack/react-router';
import { useIsFetching, useQuery } from '@tanstack/react-query';
import {
  FlaskConical,
  Gauge,
  IndianRupee,
  Inbox,
  LogOut,
  Scale,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { api, formatINR, getToken, getUser, setToken, setUser } from '../lib/api';
import type { RevenueRisk } from '../lib/types';
import { cn } from '../lib/cn';

export const Route = createRootRoute({ component: RootLayout });

const NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/', label: 'Command Center', icon: Gauge },
  { to: '/cases', label: 'Risk Queue', icon: ScrollText },
  { to: '/approvals', label: 'Human Inbox', icon: Inbox },
  { to: '/policies', label: 'Policy Studio', icon: Scale },
  { to: '/experiments', label: 'Experiments', icon: FlaskConical },
];

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const authed = Boolean(getToken());
  const user = getUser();
  const fetching = useIsFetching();
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

  if (pathname === '/login') {
    return <Outlet />;
  }

  const isActive = (to: string) => pathname === to || (to !== '/' && pathname.startsWith(to));

  return (
    <div className="min-h-[100dvh] lg:flex">
      <a
        href="#desk"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brass focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-paper"
      >
        Skip to content
      </a>
      <aside className="border-b border-rule bg-panel/70 backdrop-blur lg:sticky lg:top-0 lg:h-[100dvh] lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col gap-6 px-4 py-4 lg:px-3">
          <Link to="/" className="flex items-center gap-2.5 rounded-md px-1">
            <span className="flex h-8 w-8 items-center justify-center rounded border border-brass/40 bg-brass/10 text-brass">
              <IndianRupee size={15} strokeWidth={2.4} />
            </span>
            <span className="leading-none">
              <span className="widest block text-sm font-bold tracking-[0.12em] text-ink">RECLAIM</span>
              <span className="eyebrow mt-1 block text-[0.6rem] tracking-[0.14em]">Recovery desk</span>
            </span>
          </Link>

          <nav className="-mx-1 flex gap-1 overflow-x-auto lg:mx-0 lg:flex-col lg:overflow-visible">
            {NAV.map((item) => {
              const active = isActive(item.to);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'group relative flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ease-desk',
                    active ? 'bg-ink/[0.06] text-ink' : 'text-ash hover:bg-ink/[0.042] hover:text-ink',
                  )}
                >
                  {active && (
                    <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-brass" aria-hidden />
                  )}
                  <Icon size={15} className={cn(active ? 'text-brass' : 'text-ash group-hover:text-ink')} />
                  <span className="whitespace-nowrap">{item.label}</span>
                  {item.to === '/approvals' && awaitingHuman > 0 && (
                    <span className="tnum ml-auto rounded-full border border-marigold/40 bg-marigold/15 px-1.5 text-2xs font-semibold text-marigold">
                      {awaitingHuman}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto hidden gap-3 border-t border-rule pt-3 lg:flex lg:items-center">
            {user && (
              <div className="min-w-0 leading-tight">
                <div className="truncate text-xs font-medium text-ink">{user.name}</div>
                <div className="eyebrow mt-0.5">{user.role}</div>
              </div>
            )}
            <button
              title="Sign out"
              aria-label="Sign out"
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-ash transition-colors ease-desk hover:bg-ink/[0.055] hover:text-ink"
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
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-rule bg-paper/85 backdrop-blur">
          <div className="flex h-12 items-center gap-4 px-5">
            <span className="flex items-center gap-2 text-2xs text-ash">
              <span
                className={cn('h-1.5 w-1.5 rounded-full bg-sage', fetching > 0 && 'animate-breathe')}
                aria-hidden
              />
              {fetching > 0 ? 'Syncing' : 'Live'}
              <span className="hidden text-ash/60 sm:inline">· refreshes every 4s</span>
            </span>

            <span className="ml-auto flex items-center gap-2.5">
              <span className="eyebrow hidden sm:inline">At risk now</span>
              <span className="wide tnum text-sm font-semibold text-brass">
                {risk ? formatINR(risk.openExposurePaise) : '—'}
              </span>
            </span>

            <button
              className="flex h-8 w-8 items-center justify-center rounded-md text-ash transition-colors ease-desk hover:bg-ink/[0.055] hover:text-ink lg:hidden"
              aria-label="Sign out"
              onClick={() => {
                setToken(null);
                setUser(null);
                location.assign('/login');
              }}
            >
              <LogOut size={14} />
            </button>
          </div>
        </header>

        <main id="desk" className="mx-auto w-full max-w-[84rem] flex-1 px-5 py-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
