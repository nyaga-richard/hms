import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { asyncHandler, validate, clientIp } from '../../core/http';
import * as svc from './auth.service';
import { requireAuth } from '../../middleware/auth';
import { pool } from '../../db/pool';
import { env } from '../../config/env';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: env.isProd ? 30 : 1000, skip: () => env.isTest, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again later.' } } });

const serializeUser = (u: any) => ({
  id: u.id, username: u.username, full_name: u.full_name, email: u.email, is_superuser: u.is_superuser,
  default_property_id: u.default_property_id, department_id: u.department_id, employee_id: u.employee_id,
  must_change_password: u.must_change_password, permissions: [...u.permissions], roles: u.roles, propertyIds: u.propertyIds, limits: u.limits,
});

authRouter.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const body = validate(z.object({ username: z.string().min(1), password: z.string().min(1), deviceName: z.string().optional() }), req.body);
  const result = await svc.login(body.username, body.password, { ip: clientIp(req), userAgent: req.headers['user-agent'], deviceName: body.deviceName });
  res.json({ token: result.token, expiresAt: result.expiresAt, user: serializeUser(result.user) });
}));

authRouter.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await svc.logout(req.user!.sessionId, req.user!, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const props = req.user!.is_superuser || !req.user!.propertyIds.length
    ? (await pool.query(`SELECT id, code, name, currency, timezone FROM properties WHERE is_active ORDER BY name`)).rows
    : (await pool.query(`SELECT id, code, name, currency, timezone FROM properties WHERE is_active AND id = ANY($1) ORDER BY name`, [req.user!.propertyIds])).rows;
  const unread = Number((await pool.query(`SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [req.user!.id])).rows[0].count);
  res.json({ user: serializeUser(req.user), properties: props, activePropertyId: req.propertyId, unreadNotifications: unread });
}));

authRouter.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const b = validate(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
  await svc.changePassword(req.user!.id, b.currentPassword, b.newPassword);
  res.json({ ok: true });
}));

authRouter.post('/forgot-password', loginLimiter, asyncHandler(async (req, res) => {
  const b = validate(z.object({ identifier: z.string() }), req.body);
  const token = await svc.createPasswordReset(b.identifier);
  // Token is emailed in production. In non-production we return it to ease testing.
  res.json({ ok: true, ...(env.isProd ? {} : { resetToken: token }) });
}));

authRouter.post('/reset-password', asyncHandler(async (req, res) => {
  const b = validate(z.object({ token: z.string(), newPassword: z.string() }), req.body);
  await svc.completePasswordReset(b.token, b.newPassword);
  res.json({ ok: true });
}));

authRouter.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT id, ip_address, user_agent, device_name, created_at, last_seen_at, expires_at, (id=$2) AS current FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [req.user!.id, req.user!.sessionId])).rows;
  res.json({ data: rows });
}));

authRouter.delete('/sessions/:id', requireAuth, asyncHandler(async (req, res) => {
  await pool.query(`UPDATE user_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2`, [req.params.id, req.user!.id]);
  res.json({ ok: true });
}));

authRouter.get('/login-history', requireAuth, asyncHandler(async (req, res) => {
  const rows = (await pool.query(`SELECT success, reason, ip_address, user_agent, created_at FROM login_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user!.id])).rows;
  res.json({ data: rows });
}));

authRouter.put('/preferences', requireAuth, asyncHandler(async (req, res) => {
  await pool.query(`UPDATE users SET preferences = preferences || $2::jsonb WHERE id=$1`, [req.user!.id, JSON.stringify(req.body ?? {})]);
  res.json({ ok: true });
}));
