import { Request, Response, NextFunction } from 'express';
import { AppError } from '../core/errors';
import { env } from '../config/env';

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Postgres constraint errors → user-friendly messages
  if (err?.code === '23505') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with the same unique value already exists', details: env.isProd ? undefined : err.detail } });
  }
  if (err?.code === '23503') {
    return res.status(409).json({ error: { code: 'REFERENCE_CONSTRAINT', message: 'This record is referenced by other records and cannot be changed or deleted', details: env.isProd ? undefined : err.detail } });
  }
  if (err?.code === '23514') {
    return res.status(400).json({ error: { code: 'CHECK_CONSTRAINT', message: 'Invalid value violates a business constraint', details: env.isProd ? undefined : err.detail } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: env.isProd ? 'An unexpected error occurred' : String(err?.message ?? err) } });
}
