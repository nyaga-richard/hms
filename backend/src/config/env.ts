import dotenv from 'dotenv';
import path from 'path';

// Load <cwd>/.env first, then the repository root .env as a fallback (values already set are never overridden).
dotenv.config({ path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '..', '.env')] });

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
  port: parseInt(process.env.PORT ?? '4000', 10),
  databaseUrl: process.env.NODE_ENV === 'test'
    ? req('DATABASE_URL_TEST', process.env.DATABASE_URL)
    : req('DATABASE_URL'),
  jwtSecret: req('JWT_SECRET', 'dev_only_secret'),
  sessionTtlMinutes: parseInt(process.env.SESSION_TTL_MINUTES ?? '480', 10),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10),
  maxFailedLogins: parseInt(process.env.MAX_FAILED_LOGINS ?? '5', 10),
  lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES ?? '15', 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  storagePath: process.env.STORAGE_PATH ?? './uploads',
  backupPath: process.env.BACKUP_PATH ?? './backups',
  uploadMaxSize: parseInt(process.env.UPLOAD_MAX_SIZE ?? '10485760', 10),
  defaultCurrency: process.env.DEFAULT_CURRENCY ?? 'KES',
  defaultTimezone: process.env.DEFAULT_TIMEZONE ?? 'Africa/Nairobi',
  // Reverse-proxy hops in front of the API (nginx = 1). Used for req.ip / rate limiting.
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10),
  // Per-client-IP limits. Behind NAT a whole property may share one public IP, so keep these generous;
  // per-account brute-force protection is handled separately by MAX_FAILED_LOGINS / LOCKOUT_MINUTES.
  rateLimitApiPerMinute: parseInt(process.env.RATE_LIMIT_API_PER_MINUTE ?? '1200', 10),
  rateLimitLoginPer15Min: parseInt(process.env.RATE_LIMIT_LOGIN_PER_15MIN ?? (process.env.NODE_ENV === 'production' ? '100' : '1000'), 10),
};
