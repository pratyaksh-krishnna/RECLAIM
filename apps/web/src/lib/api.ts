const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export function getToken(): string | null {
  return localStorage.getItem('reclaim.token');
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem('reclaim.token', token);
  else localStorage.removeItem('reclaim.token');
}
export function getUser(): { name: string; role: string } | null {
  const raw = localStorage.getItem('reclaim.user');
  return raw ? (JSON.parse(raw) as { name: string; role: string }) : null;
}
export function setUser(user: unknown): void {
  if (user) localStorage.setItem('reclaim.user', JSON.stringify(user));
  else localStorage.removeItem('reclaim.user');
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    setToken(null);
    if (!location.pathname.startsWith('/login')) location.assign('/login');
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return (await res.json()) as T;
}

export function formatINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}
export function formatINRExact(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
