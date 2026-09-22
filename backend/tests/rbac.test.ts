import { describe, it, expect, beforeAll } from 'vitest';
import { login, client, expectStatus, Client } from './helpers';

/**
 * RBAC is enforced by the backend on every route via requirePermission(...).
 * Hiding a button in the UI is never the security boundary.
 */
describe('Role-based access control', () => {
  let admin: Client; let housekeeper: Client; let auditor: Client; let reception: Client;
  beforeAll(async () => {
    admin = client(await login('admin'));
    housekeeper = client(await login('housekeeper'));
    auditor = client(await login('auditor'));
    reception = client(await login('reception'));
  });

  it('denies a housekeeper access to accounting (403 FORBIDDEN)', async () => {
    const res = await housekeeper.get('/api/journals');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('read-only auditor can view journals but cannot post them', async () => {
    expectStatus(await auditor.get('/api/journals?pageSize=1'), 200);
    const post = await auditor.post('/api/journals', { description: 'should be denied', lines: [] });
    expect(post.status).toBe(403);
  });

  it('receptionist can create reservations but cannot manage roles or users', async () => {
    expectStatus(await reception.get('/api/reservations?pageSize=1'), 200);
    expect((await reception.get('/api/roles')).status).toBe(403);
    expect((await reception.post('/api/users', { username: 'hacker', full_name: 'Nope', password: 'x' })).status).toBe(403);
  });

  it('permissions are data-driven: a new role with a granted permission unlocks the route immediately', async () => {
    const perms = expectStatus(await admin.get('/api/permissions'), 200).body;
    const codes: string[] = (Array.isArray(perms) ? perms : perms.data).map((p: any) => p.code);
    expect(codes).toContain('accounting.view');

    const roleCode = `TEST_LEDGER_READER_${Date.now().toString(36).toUpperCase()}`;
    const role = expectStatus(await admin.post('/api/roles', { code: roleCode, name: 'Ledger Reader (test)', permissions: ['dashboard.view', 'accounting.view'] }), 201);
    const username = `ledger_${Date.now().toString(36)}`;
    expectStatus(await admin.post('/api/users', { username, full_name: 'Ledger Reader', password: 'Ledger12345!', is_active: true, role_ids: [role.body.id] }), 201);

    const c = client(await login(username, 'Ledger12345!'));
    expectStatus(await c.get('/api/journals?pageSize=1'), 200);            // granted
    expect((await c.get('/api/reservations')).status).toBe(403);           // not granted
    expect((await c.post('/api/journals', { description: 'nope', lines: [] })).status).toBe(403); // accounting.post not granted

    // Revoking the permission on the role takes effect for existing sessions too.
    expectStatus(await admin.put(`/api/roles/${role.body.id}`, { code: roleCode, name: 'Ledger Reader (test)', permissions: ['dashboard.view'] }), 200);
    expect((await c.get('/api/journals?pageSize=1')).status).toBe(403);
  });

  it('per-user DENY overrides beat role grants', async () => {
    const roles = expectStatus(await admin.get('/api/roles'), 200).body;
    const receptionRole = (Array.isArray(roles) ? roles : roles.data).find((r: any) => r.code === 'RECEPTIONIST');
    expect(receptionRole).toBeTruthy();
    const username = `deny_${Date.now().toString(36)}`;
    expectStatus(await admin.post('/api/users', {
      username, full_name: 'Deny Override', password: 'Deny12345!', is_active: true, role_ids: [receptionRole.id],
      permission_overrides: [{ code: 'reservations.view', effect: 'DENY' }],
    }), 201);
    const c = client(await login(username, 'Deny12345!'));
    expect((await c.get('/api/reservations')).status).toBe(403);
    expectStatus(await c.get('/api/guests?pageSize=1'), 200);
  });
});
