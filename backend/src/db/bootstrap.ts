import { pool } from './pool';
import { PERMISSIONS } from '../core/permissions';

/** Synchronise the permission catalog into the database (idempotent, never deletes data). */
export async function bootstrapPermissions() {
  for (const p of PERMISSIONS) {
    await pool.query(`INSERT INTO permissions (code, module, description) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET module=EXCLUDED.module, description=EXCLUDED.description`, [p.code, p.module, p.description]);
  }
  // Ensure system role SUPER_ADMIN exists and has everything
  await pool.query(`INSERT INTO roles (code, name, description, is_system) VALUES ('SUPER_ADMIN','Super Administrator','Full system access', true) ON CONFLICT (code) DO NOTHING`);
  await pool.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.code='SUPER_ADMIN' ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO currencies (code, name, symbol) VALUES ('KES','Kenyan Shilling','KSh'),('USD','US Dollar','$'),('EUR','Euro','€'),('GBP','British Pound','£'),('TZS','Tanzanian Shilling','TSh'),('UGX','Ugandan Shilling','USh') ON CONFLICT (code) DO NOTHING`);
}
