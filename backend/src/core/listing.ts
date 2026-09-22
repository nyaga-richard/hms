import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { getPagination, paged, sendExport , isExport } from './http';
import { hasPermission } from '../middleware/auth';
import { Forbidden } from './errors';

export interface ListSpec {
  /** SELECT ... FROM ... JOIN ... (no WHERE) */
  select: string;
  /** Static predicates (use $1.. indexes continuing from params) */
  where?: string[];
  params?: any[];
  /** Columns searched with ILIKE when ?search= is given */
  searchColumns?: string[];
  defaultSort?: string;
  /** map of query param → SQL column for exact-match filters */
  filters?: Record<string, string>;
  /** map of query param → SQL column for date range filters: from_<param>/to_<param> */
  dateFilters?: Record<string, string>;
  exportName?: string;
  /** extra transform applied to each row */
  map?: (row: any) => any;
}

/**
 * Generic paginated/filterable/sortable/exportable list runner for custom endpoints.
 * Supports ?page ?pageSize ?sort ?order ?search ?format=csv plus the configured filters.
 */
export async function runList(req: Request, res: Response, spec: ListSpec) {
  const p = getPagination(req, spec.defaultSort ?? 'created_at');
  const where = [...(spec.where ?? [])];
  const params = [...(spec.params ?? [])];
  const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace(/\$P/g, `$${params.length}`)); };
  if (p.search && spec.searchColumns?.length) add('(' + spec.searchColumns.map((c) => `CAST(${c} AS TEXT) ILIKE $P`).join(' OR ') + ')', `%${p.search}%`);
  for (const [q, col] of Object.entries(spec.filters ?? {})) {
    const v = req.query[q];
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) add(`${col} = ANY($P)`, v);
    else if (typeof v === 'string' && v.includes(',')) add(`${col} = ANY($P)`, v.split(','));
    else if (v === 'true' || v === 'false') add(`${col} = $P`, v === 'true');
    else if (v === 'null') where.push(`${col} IS NULL`);
    else add(`${col} = $P`, v);
  }
  for (const [q, col] of Object.entries(spec.dateFilters ?? {})) {
    const from = req.query[`from_${q}`] ?? (q === 'date' ? req.query.from : undefined);
    const to = req.query[`to_${q}`] ?? (q === 'date' ? req.query.to : undefined);
    if (from) add(`${col} >= $P`, from);
    if (to) add(`${col} <= $P`, to);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const sortCol = /^[a-zA-Z0-9_.]+$/.test(p.sort!) ? p.sort : spec.defaultSort ?? 'created_at';
  const orderSql = ` ORDER BY ${sortCol} ${p.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
  const total = Number((await pool.query(`SELECT COUNT(*) FROM (${spec.select}${whereSql}) x`, params)).rows[0].count);
  if (isExport(req)) {
    if (!hasPermission(req, 'reports.export')) throw new Forbidden('Export permission required');
    const rows = (await pool.query(`${spec.select}${whereSql}${orderSql} LIMIT 10000`, params)).rows;
    return sendExport(res, req, spec.map ? rows.map(spec.map) : rows, spec.exportName ?? 'export');
  }
  const rows = (await pool.query(`${spec.select}${whereSql}${orderSql} LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`, params)).rows;
  res.json(paged(spec.map ? rows.map(spec.map) : rows, total, p));
}
