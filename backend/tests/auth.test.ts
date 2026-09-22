import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, login, client, expectStatus, PASSWORD } from './helpers';

describe('Authentication', () => {
  it('health endpoint is public', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('logs in with valid credentials and returns a bearer token + permissions', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.username).toBe('admin');
    expect(Array.isArray(res.body.user.permissions)).toBe(true);
  });

  it('rejects invalid credentials with 401 INVALID_CREDENTIALS', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('protects every /api route: missing or bad token → 401', async () => {
    expect((await request(app).get('/api/reservations')).status).toBe(401);
    expect((await request(app).get('/api/reservations').set('Authorization', 'Bearer not-a-real-token')).status).toBe(401);
  });

  it('/auth/me returns the current user and logout revokes the session', async () => {
    const token = await login('reception');
    const c = client(token);
    const me = expectStatus(await c.get('/api/auth/me'), 200);
    expect((me.body.user ?? me.body).username).toBe('reception');
    expectStatus(await c.post('/api/auth/logout'), 200, 204);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('locks an account after repeated failed logins (brute-force protection)', async () => {
    // Create a throw-away user so the demo accounts stay usable.
    const admin = client(await login('admin'));
    const username = `locktest_${Date.now().toString(36)}`;
    expectStatus(await admin.post('/api/users', { username, full_name: 'Lockout Test', password: 'Secret12345!', is_active: true }), 201);
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app).post('/api/auth/login').send({ username, password: 'nope' });
      expect([401, 403]).toContain(r.status);
    }
    const locked = await request(app).post('/api/auth/login').send({ username, password: 'Secret12345!' });
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});
