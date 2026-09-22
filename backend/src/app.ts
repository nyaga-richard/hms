import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { requireAuth } from './middleware/auth';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter, rolesRouter, permissionsRouter } from './modules/admin/users.routes';
import { propertiesRouter, companiesRouter, departmentsRouter, employeesRouter, shiftTemplatesRouter, settingsRouter, workflowsRouter, approvalsRouter, auditRouter, notificationsRouter } from './modules/admin/admin.routes';
import { registerModuleRoutes } from './modules';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.trustProxyHops);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigins.includes('*') ? true : env.corsOrigins, credentials: true, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: env.rateLimitApiPerMinute, standardHeaders: true, legacyHeaders: false, skip: () => env.isTest,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } } }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'hms-backend', time: new Date().toISOString() }));
  app.use('/api/auth', authRouter);

  // Everything below requires authentication; each route enforces its own permission.
  const api = express.Router();
  api.use(requireAuth);
  api.use('/users', usersRouter);
  api.use('/roles', rolesRouter);
  api.use('/permissions', permissionsRouter);
  api.use('/properties', propertiesRouter);
  api.use('/companies', companiesRouter);
  api.use('/departments', departmentsRouter);
  api.use('/employees', employeesRouter);
  api.use('/shift-templates', shiftTemplatesRouter);
  api.use('/settings', settingsRouter);
  api.use('/workflows', workflowsRouter);
  api.use('/approvals', approvalsRouter);
  api.use('/audit', auditRouter);
  api.use('/notifications', notificationsRouter);
  registerModuleRoutes(api);
  app.use('/api', api);
  app.use('/uploads', requireAuth, express.static(path.resolve(env.storagePath)));

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }));
  app.use(errorHandler);
  return app;
}
