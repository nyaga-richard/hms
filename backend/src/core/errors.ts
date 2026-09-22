export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export class BadRequest extends AppError { constructor(msg = 'Bad request', details?: unknown, code = 'BAD_REQUEST') { super(400, code, msg, details); } }
export class Unauthorized extends AppError { constructor(msg = 'Authentication required', code = 'UNAUTHORIZED') { super(401, code, msg); } }
export class Forbidden extends AppError { constructor(msg = 'You do not have permission to perform this action', code = 'FORBIDDEN') { super(403, code, msg); } }
export class NotFound extends AppError { constructor(msg = 'Record not found') { super(404, 'NOT_FOUND', msg); } }
export class Conflict extends AppError { constructor(msg = 'Conflict', code = 'CONFLICT', details?: unknown) { super(409, code, msg, details); } }
export class BusinessRuleError extends AppError { constructor(code: string, msg: string, details?: unknown) { super(422, code, msg, details); } }

// Domain-specific errors with user-understandable messages
export const Errors = {
  roomUnavailable: (room: string) => new BusinessRuleError('ROOM_UNAVAILABLE', `Room ${room} is not available for the requested dates`),
  reservationConflict: (room: string) => new BusinessRuleError('RESERVATION_CONFLICT', `Room ${room} is already booked for overlapping dates`),
  insufficientStock: (item: string, available: number, requested: number) =>
    new BusinessRuleError('INSUFFICIENT_STOCK', `Insufficient stock for ${item}: available ${available}, requested ${requested}`),
  unauthorizedDiscount: (limit: number) => new BusinessRuleError('UNAUTHORIZED_DISCOUNT', `Discount exceeds your authority limit of ${limit}%. Manager approval required.`),
  unauthorizedRefund: () => new BusinessRuleError('UNAUTHORIZED_REFUND', 'You are not authorized to issue refunds'),
  closedShift: () => new BusinessRuleError('CLOSED_SHIFT', 'No open cashier shift. Please open a shift before transacting.'),
  closedPeriod: (d: string) => new BusinessRuleError('CLOSED_PERIOD', `Accounting period for ${d} is closed. Post to an open period or reopen the period.`),
  invalidPayment: (m: string) => new BusinessRuleError('INVALID_PAYMENT', m),
  duplicate: (m = 'Duplicate transaction detected') => new BusinessRuleError('DUPLICATE_TRANSACTION', m),
  invalidAdjustment: (m: string) => new BusinessRuleError('INVALID_STOCK_ADJUSTMENT', m),
  missingApproval: (m = 'This transaction requires approval before it can proceed') => new BusinessRuleError('MISSING_APPROVAL', m),
  invalidStatus: (entity: string, status: string, action: string) =>
    new BusinessRuleError('INVALID_STATUS', `Cannot ${action}: ${entity} is ${status}`),
  unbalancedJournal: (dr: number, cr: number) => new BusinessRuleError('UNBALANCED_JOURNAL', `Journal does not balance: debits ${dr} vs credits ${cr}`),
};
