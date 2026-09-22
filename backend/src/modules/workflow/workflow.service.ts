import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../db/pool';
import { AuthUser } from '../auth/auth.types';
import { Forbidden, NotFound, Errors } from '../../core/errors';
import { notify } from '../../core/notify';
import { audit } from '../../core/audit';

/**
 * Configurable approval workflow engine.
 * Definitions are matched by transaction_type + property + amount band.
 * If no definition exists, the transaction is auto-approved (the caller decides whether that is allowed).
 */
export type OnApproved = (client: PoolClient, entityId: string, request: any, user: AuthUser) => Promise<void>;
export type OnRejected = (client: PoolClient, entityId: string, request: any, user: AuthUser, comment?: string) => Promise<void>;

const handlers: Record<string, { onApproved: OnApproved; onRejected?: OnRejected }> = {};

export function registerWorkflowHandler(transactionType: string, h: { onApproved: OnApproved; onRejected?: OnRejected }) {
  handlers[transactionType] = h;
}

export async function findDefinition(client: PoolClient, transactionType: string, propertyId: string | null, amount: number) {
  const r = await client.query(
    `SELECT d.*, (SELECT COUNT(*) FROM workflow_steps s WHERE s.definition_id=d.id AND s.min_amount <= $3) AS steps
       FROM workflow_definitions d
      WHERE d.transaction_type=$1 AND d.is_active AND (d.property_id=$2 OR d.property_id IS NULL)
        AND d.min_amount <= $3 AND (d.max_amount IS NULL OR d.max_amount >= $3)
      ORDER BY d.property_id NULLS LAST, d.min_amount DESC LIMIT 1`,
    [transactionType, propertyId, amount],
  );
  return r.rows[0] ?? null;
}

/**
 * Start an approval. Returns { status: 'APPROVED' } if no workflow applies (auto approval)
 * or { status: 'PENDING', requestId } when approvals are needed.
 */
export async function startApproval(client: PoolClient, opts: {
  transactionType: string; entityType: string; entityId: string; entityNumber?: string; amount: number;
  propertyId: string | null; user: AuthUser; title?: string; link?: string;
}): Promise<{ status: 'APPROVED' | 'PENDING'; requestId?: string }> {
  const def = await findDefinition(client, opts.transactionType, opts.propertyId, opts.amount);
  const steps = def ? (await client.query(`SELECT * FROM workflow_steps WHERE definition_id=$1 AND min_amount <= $2 ORDER BY step_order`, [def.id, opts.amount])).rows : [];
  if (!def || !steps.length) return { status: 'APPROVED' };
  // cancel any previous pending request for the same entity (resubmission)
  await client.query(`UPDATE approval_requests SET status='CANCELLED', completed_at=now() WHERE entity_type=$1 AND entity_id=$2 AND status='PENDING'`, [opts.entityType, opts.entityId]);
  const req = (await client.query(
    `INSERT INTO approval_requests (property_id, definition_id, transaction_type, entity_type, entity_id, entity_number, amount, current_step, total_steps, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9) RETURNING *`,
    [opts.propertyId, def.id, opts.transactionType, opts.entityType, opts.entityId, opts.entityNumber ?? null, opts.amount, steps.length, opts.user.id],
  )).rows[0];
  await notifyStepApprovers(client, req, steps[0], opts.title ?? `${opts.transactionType} ${opts.entityNumber ?? ''} awaiting your approval`, opts.link);
  return { status: 'PENDING', requestId: req.id };
}

async function notifyStepApprovers(client: PoolClient, req: any, step: any, title: string, link?: string) {
  const userIds: string[] = [];
  if (step.approver_user_id) userIds.push(step.approver_user_id);
  let roleCodes: string[] | undefined;
  if (step.approver_role_id) {
    const r = (await client.query(`SELECT code FROM roles WHERE id=$1`, [step.approver_role_id])).rows[0];
    if (r) roleCodes = [r.code];
  }
  await notify({ userIds, roleCodes, permission: !userIds.length && !roleCodes ? (step.required_permission ?? 'approvals.act') : undefined,
    propertyId: req.property_id, type: 'APPROVAL_REQUIRED', title, body: `Amount: ${Number(req.amount).toFixed(2)} · Step ${step.step_order}: ${step.name}`,
    entityType: req.entity_type, entityId: req.entity_id, link: link ?? '/approvals', severity: 'WARNING' }, client);
}

async function userCanActOnStep(client: PoolClient, user: AuthUser, step: any): Promise<boolean> {
  if (user.is_superuser) return true;
  if (step.approver_user_id && step.approver_user_id === user.id) return true;
  if (step.approver_role_id && user.roles.some((r) => r.id === step.approver_role_id)) return true;
  if (step.required_permission && user.permissions.has(step.required_permission)) return true;
  if (!step.approver_user_id && !step.approver_role_id && !step.required_permission) return user.permissions.has('approvals.act');
  return false;
}

export async function actOnApproval(requestId: string, user: AuthUser, action: 'APPROVE' | 'REJECT' | 'RETURN', comment?: string) {
  return withTransaction(async (client) => {
    const req = (await client.query(`SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE`, [requestId])).rows[0];
    if (!req) throw new NotFound('Approval request not found');
    if (req.status !== 'PENDING') throw Errors.invalidStatus('approval request', req.status, action.toLowerCase());
    const steps = (await client.query(`SELECT * FROM workflow_steps WHERE definition_id=$1 AND min_amount <= $2 ORDER BY step_order`, [req.definition_id, req.amount])).rows;
    const step = steps[req.current_step - 1];
    if (!step) throw new NotFound('Workflow step not found');
    if (!(await userCanActOnStep(client, user, step))) throw new Forbidden(`You are not an authorized approver for step "${step.name}"`);
    if (req.requested_by === user.id && !user.is_superuser) throw new Forbidden('You cannot approve your own request');
    await client.query(`INSERT INTO approval_actions (request_id, step_order, step_name, user_id, action, comment) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.id, step.step_order, step.name, user.id, action, comment ?? null]);
    const handler = handlers[req.transaction_type];
    if (action === 'REJECT' || action === 'RETURN') {
      await client.query(`UPDATE approval_requests SET status='REJECTED', completed_at=now() WHERE id=$1`, [req.id]);
      if (handler?.onRejected) await handler.onRejected(client, req.entity_id, req, user, comment);
      await notify({ userIds: [req.requested_by], propertyId: req.property_id, type: 'APPROVAL_REJECTED', title: `${req.transaction_type} ${req.entity_number ?? ''} was ${action === 'RETURN' ? 'returned' : 'rejected'}`, body: comment, entityType: req.entity_type, entityId: req.entity_id, severity: 'WARNING' }, client);
      await audit({ userId: user.id, username: user.username, propertyId: req.property_id, action: 'REJECT', entityType: req.entity_type, entityId: req.entity_id, reason: comment }, client);
      return { status: 'REJECTED' };
    }
    if (req.current_step >= steps.length) {
      await client.query(`UPDATE approval_requests SET status='APPROVED', completed_at=now() WHERE id=$1`, [req.id]);
      if (handler) await handler.onApproved(client, req.entity_id, req, user);
      await notify({ userIds: [req.requested_by], propertyId: req.property_id, type: 'APPROVAL_APPROVED', title: `${req.transaction_type} ${req.entity_number ?? ''} approved`, entityType: req.entity_type, entityId: req.entity_id, severity: 'SUCCESS' }, client);
      await audit({ userId: user.id, username: user.username, propertyId: req.property_id, action: 'APPROVE', entityType: req.entity_type, entityId: req.entity_id, reason: comment }, client);
      return { status: 'APPROVED' };
    }
    await client.query(`UPDATE approval_requests SET current_step=current_step+1 WHERE id=$1`, [req.id]);
    await notifyStepApprovers(client, { ...req, current_step: req.current_step + 1 }, steps[req.current_step], `${req.transaction_type} ${req.entity_number ?? ''} awaiting your approval`);
    await audit({ userId: user.id, username: user.username, propertyId: req.property_id, action: 'APPROVE', entityType: req.entity_type, entityId: req.entity_id, reason: `Step ${step.step_order} ${step.name}` }, client);
    return { status: 'PENDING', currentStep: req.current_step + 1 };
  });
}

export async function pendingApprovalsFor(user: AuthUser, propertyId: string | null) {
  const r = await pool.query(
    `SELECT ar.*, s.name AS step_name, s.approver_role_id, s.approver_user_id, s.required_permission, u.full_name AS requested_by_name
       FROM approval_requests ar
       JOIN workflow_steps s ON s.definition_id=ar.definition_id AND s.step_order=ar.current_step
       LEFT JOIN users u ON u.id=ar.requested_by
      WHERE ar.status='PENDING' AND ($1::uuid IS NULL OR ar.property_id=$1 OR ar.property_id IS NULL)
      ORDER BY ar.requested_at`, [propertyId]);
  const out = [];
  for (const row of r.rows) {
    const can = user.is_superuser || (row.approver_user_id && row.approver_user_id === user.id) || (row.approver_role_id && user.roles.some((x) => x.id === row.approver_role_id))
      || (row.required_permission && user.permissions.has(row.required_permission)) || (!row.approver_user_id && !row.approver_role_id && !row.required_permission && user.permissions.has('approvals.act'));
    if (can || row.requested_by === user.id) out.push({ ...row, can_act: !!can && row.requested_by !== user.id });
  }
  return out;
}
