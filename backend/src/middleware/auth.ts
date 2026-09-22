import { Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../modules/auth/auth.service';
import { Unauthorized, Forbidden } from '../core/errors';
import { asyncHandler } from '../core/http';

/** Authenticate bearer token; attaches req.user and resolves the active property context. */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
  if (!token) throw new Unauthorized('Authentication required', 'NO_TOKEN');
  const user = await authenticateToken(token);
  if (!user) throw new Unauthorized('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  req.user = user;
  req.token = token;
  // Property context: header X-Property-Id, else user default. Enforce property restriction.
  const requested = (req.headers['x-property-id'] as string | undefined) || (req.query.propertyId as string | undefined) || user.default_property_id || null;
  if (requested && user.propertyIds.length && !user.propertyIds.includes(requested) && !user.is_superuser) {
    throw new Forbidden('You are not assigned to this property', 'PROPERTY_FORBIDDEN');
  }
  req.propertyId = requested;
  next();
});

/** Enforce that the user holds at least one of the given permissions. Backend is the source of truth. */
export function requirePermission(...codes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = req.user;
    if (!u) return next(new Unauthorized());
    if (u.is_superuser || codes.some((c) => u.permissions.has(c))) return next();
    return next(new Forbidden(`Missing permission: ${codes.join(' or ')}`));
  };
}

export function hasPermission(req: Request, code: string) {
  return !!req.user && (req.user.is_superuser || req.user.permissions.has(code));
}

/** Returns SQL fragment + params ensuring rows belong to properties the user can access */
export function propertyFilter(req: Request, column = 'property_id'): { sql: string; params: any[] } {
  const u = req.user!;
  if (req.propertyId) return { sql: `${column} = $PARAM`, params: [req.propertyId] };
  if (u.is_superuser || !u.propertyIds.length) return { sql: 'TRUE', params: [] };
  return { sql: `${column} = ANY($PARAM)`, params: [u.propertyIds] };
}

export function getLimit(req: Request, code: string, fallback = 0): number {
  if (req.user?.is_superuser) return Number.MAX_SAFE_INTEGER;
  return req.user?.limits[code] ?? fallback;
}
