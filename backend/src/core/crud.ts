import { Router, Request } from 'express';
import { ZodSchema } from 'zod';
import { pool } from '../db/pool';
import { asyncHandler, getPagination, paged, validate, sendExport , isExport } from './http';
import { requirePermission, propertyFilter, hasPermission } from '../middleware/auth';
import { NotFound, Forbidden } from './errors';
import { audit, auditCtx } from './audit';

export interface CrudOptions {
  table: string;
  entity: string;
  permissions: { view: string; create?: string; edit?: string; delete?: string };
  createSchema: ZodSchema<any>;
  updateSchema: ZodSchema<any>;
  searchColumns?: string[];
  propertyScoped?: boolean;         // table has property_id
  fixedWhere?: { sql: string; params: any[] } | ((req: Request) => { sql: string; params: any[] }); // always-applied predicate (use $PARAM placeholders), e.g. t.type = 'BAR'
  defaultSort?: string;
  selectSql?: string;               // custom SELECT for list/detail (must alias base table as t)
  filters?: Record<string, string>; // query param → column (exact match)
  softDelete?: boolean;             // uses is_active=false instead of DELETE
  beforeCreate?: (data: any, req: Request) => Promise<any> | any;
  beforeUpdate?: (data: any, req: Request, existing: any) => Promise<any> | any;
  afterCreate?: (row: any, req: Request) => Promise<void>;
  extraRoutes?: (router: Router) => void;
  allowedSorts?: string[];
}

/**
 * Generic, permission-enforced CRUD router for master data.
 * - Paginated list with search/sort/filter/export
 * - Property scoping enforced server-side
 * - Full audit trail on create/update/delete
 */
export function crudRouter(o: CrudOptions): Router {
  const r = Router();
  // Extra routes first so static paths like /tree or /lookup/:code are not shadowed by /:id
  o.extraRoutes?.(r);
  const select = o.selectSql ?? `SELECT t.* FROM ${o.table} t`;
  const sortable = new Set(o.allowedSorts ?? []);

  r.get('/', requirePermission(o.permissions.view), asyncHandler(async (req, res) => {
    const p = getPagination(req, o.defaultSort ?? 'created_at');
    const where: string[] = [];
    const params: any[] = [];
    const add = (sql: string, ...vals: any[]) => { let s = sql; vals.forEach((v) => { params.push(v); s = s.replace('$PARAM', `$${params.length}`); }); where.push(s); };
    if (o.propertyScoped) { const pf = propertyFilter(req, 't.property_id'); if (pf.params.length) add(pf.sql, pf.params[0]); }
    if (o.fixedWhere) { const fw = typeof o.fixedWhere === 'function' ? o.fixedWhere(req) : o.fixedWhere; add(fw.sql, ...fw.params); }
    if (p.search && o.searchColumns?.length) {
      params.push(`%${p.search}%`);
      where.push('(' + o.searchColumns.map((c) => `CAST(${c.includes('.') ? c : 't.' + c} AS TEXT) ILIKE $${params.length}`).join(' OR ') + ')');
    }
    for (const [q, col] of Object.entries(o.filters ?? {})) {
      const v = req.query[q];
      if (v !== undefined && v !== '') {
        if (v === 'true' || v === 'false') add(`${col.includes('.') ? col : 't.' + col} = $PARAM`, v === 'true');
        else add(`${col.includes('.') ? col : 't.' + col} = $PARAM`, v);
      }
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const sortCol = sortable.has(p.sort!) || /^[a-z_]+$/.test(p.sort!) ? (p.sort!.includes('.') ? p.sort : `t.${p.sort}`) : `t.${o.defaultSort ?? 'created_at'}`;
    const total = Number((await pool.query(`SELECT COUNT(*) FROM (${select}${whereSql}) x`, params)).rows[0].count);
    if (isExport(req)) {
      if (!hasPermission(req, 'reports.export')) throw new Forbidden('Export permission required');
      const rows = (await pool.query(`${select}${whereSql} ORDER BY ${sortCol} ${p.order} LIMIT 10000`, params)).rows;
      return sendExport(res, req, rows, o.entity);
    }
    const rows = (await pool.query(`${select}${whereSql} ORDER BY ${sortCol} ${p.order} NULLS LAST LIMIT ${p.pageSize} OFFSET ${p.offset}`, params)).rows;
    res.json(paged(rows, total, p));
  }));

  r.get('/:id', requirePermission(o.permissions.view), asyncHandler(async (req, res) => {
    const row = (await pool.query(`${select} WHERE t.id=$1`, [req.params.id])).rows[0];
    if (!row) throw new NotFound(`${o.entity} not found`);
    if (o.propertyScoped && row.property_id && req.user!.propertyIds.length && !req.user!.is_superuser && !req.user!.propertyIds.includes(row.property_id)) throw new Forbidden();
    res.json(row);
  }));

  if (o.permissions.create) {
    r.post('/', requirePermission(o.permissions.create), asyncHandler(async (req, res) => {
      let data = validate(o.createSchema, req.body);
      if (o.propertyScoped && !data.property_id) data.property_id = req.propertyId;
      if (o.beforeCreate) data = (await o.beforeCreate(data, req)) ?? data;
      const cols = Object.keys(data).filter((k) => data[k] !== undefined);
      const vals = cols.map((k) => (data[k] !== null && typeof data[k] === 'object' && !Array.isArray(data[k]) ? JSON.stringify(data[k]) : data[k]));
      const row = (await pool.query(`INSERT INTO ${o.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals)).rows[0];
      await audit({ ...auditCtx(req), action: 'CREATE', entityType: o.entity, entityId: row.id, newValue: row });
      if (o.afterCreate) await o.afterCreate(row, req);
      const full = (await pool.query(`${select} WHERE t.id=$1`, [row.id])).rows[0] ?? row;
      res.status(201).json(full);
    }));
  }
  if (o.permissions.edit) {
    r.put('/:id', requirePermission(o.permissions.edit), asyncHandler(async (req, res) => {
      const existing = (await pool.query(`SELECT * FROM ${o.table} WHERE id=$1`, [req.params.id])).rows[0];
      if (!existing) throw new NotFound(`${o.entity} not found`);
      let data = validate(o.updateSchema, req.body);
      if (o.beforeUpdate) data = (await o.beforeUpdate(data, req, existing)) ?? data;
      const cols = Object.keys(data).filter((k) => data[k] !== undefined);
      if (!cols.length) return res.json(existing);
      const vals = cols.map((k) => (data[k] !== null && typeof data[k] === 'object' && !Array.isArray(data[k]) ? JSON.stringify(data[k]) : data[k]));
      const row = (await pool.query(`UPDATE ${o.table} SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`, [req.params.id, ...vals])).rows[0];
      await audit({ ...auditCtx(req), action: 'UPDATE', entityType: o.entity, entityId: row.id, oldValue: existing, newValue: row });
      const full = (await pool.query(`${select} WHERE t.id=$1`, [row.id])).rows[0] ?? row;
      res.json(full);
    }));
  }
  if (o.permissions.delete) {
    r.delete('/:id', requirePermission(o.permissions.delete), asyncHandler(async (req, res) => {
      const existing = (await pool.query(`SELECT * FROM ${o.table} WHERE id=$1`, [req.params.id])).rows[0];
      if (!existing) throw new NotFound(`${o.entity} not found`);
      if (o.softDelete) await pool.query(`UPDATE ${o.table} SET is_active=false WHERE id=$1`, [req.params.id]);
      else await pool.query(`DELETE FROM ${o.table} WHERE id=$1`, [req.params.id]);
      await audit({ ...auditCtx(req), action: o.softDelete ? 'DEACTIVATE' : 'DELETE', entityType: o.entity, entityId: req.params.id, oldValue: existing, reason: req.body?.reason });
      res.json({ ok: true });
    }));
  }
  return r;
}
