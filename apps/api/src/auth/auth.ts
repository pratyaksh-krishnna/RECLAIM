import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { UserRole } from '@reclaim/shared';
import { env } from '../config/env.js';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export interface SessionClaims {
  sub: string;
  email: string;
  role: UserRole;
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: '12h' });
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded !== 'object' || decoded === null) return null;
    const role = UserRole.safeParse((decoded as { role?: unknown }).role);
    const sub = (decoded as { sub?: unknown }).sub;
    const email = (decoded as { email?: unknown }).email;
    if (!role.success || typeof sub !== 'string' || typeof email !== 'string') return null;
    return { sub, email, role: role.data };
  } catch {
    return null;
  }
}

export type AuthedRequest = Request & { session?: SessionClaims };

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

export function requireRole(minRole: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? verifySession(token) : null;
    if (!claims) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (ROLE_RANK[claims.role] < ROLE_RANK[minRole]) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    (req as AuthedRequest).session = claims;
    next();
  };
}
