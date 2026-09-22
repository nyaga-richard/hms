/**
 * Permission catalog. Every permission the backend enforces is declared here and
 * synchronised into the permissions table by the seed/migration bootstrap.
 * Roles are NOT hard-coded: administrators compose any role from these permissions.
 */
export interface PermissionDef { code: string; module: string; description: string }

const M = (module: string, entries: [string, string][]): PermissionDef[] =>
  entries.map(([code, description]) => ({ code: `${module}.${code}`, module, description }));

export const PERMISSIONS: PermissionDef[] = [
  ...M('users', [['view', 'View users'], ['create', 'Create users'], ['edit', 'Edit users'], ['disable', 'Disable/enable users'], ['reset_password', 'Reset user passwords'], ['sessions', 'Manage user sessions']]),
  ...M('roles', [['view', 'View roles'], ['create', 'Create roles'], ['edit', 'Edit roles & permissions'], ['delete', 'Delete roles']]),
  ...M('properties', [['view', 'View properties'], ['create', 'Create properties'], ['edit', 'Edit properties']]),
  ...M('departments', [['view', 'View departments'], ['manage', 'Manage departments']]),
  ...M('employees', [['view', 'View employees'], ['manage', 'Manage employees & shifts']]),
  ...M('settings', [['view', 'View settings'], ['edit', 'Edit settings, numbering & taxes'], ['workflows', 'Configure approval workflows'], ['backup', 'Run backups & restore']]),
  ...M('audit', [['view', 'View audit logs']]),
  ...M('guests', [['view', 'View guests'], ['create', 'Create guests'], ['edit', 'Edit guests'], ['merge', 'Merge guest profiles']]),
  ...M('room_types', [['view', 'View room types'], ['manage', 'Manage room types & rates']]),
  ...M('rooms', [['view', 'View rooms'], ['create', 'Create rooms'], ['edit', 'Edit rooms'], ['block', 'Block rooms / out of order'], ['items', 'Manage in-room items']]),
  ...M('reservations', [['view', 'View reservations'], ['create', 'Create reservations'], ['modify', 'Modify reservations'], ['cancel', 'Cancel reservations'], ['overbook', 'Authorize overbooking'], ['no_show', 'Mark no-shows']]),
  ...M('checkin', [['create', 'Check-in guests']]),
  ...M('checkout', [['create', 'Check-out guests']]),
  ...M('folios', [['view', 'View guest folios'], ['post', 'Post charges'], ['transfer', 'Transfer charges'], ['reverse', 'Reverse charges'], ['discount', 'Apply folio discounts']]),
  ...M('housekeeping', [['view', 'View housekeeping'], ['update', 'Update room cleaning status'], ['assign', 'Assign housekeeping tasks'], ['inspect', 'Inspect rooms']]),
  ...M('laundry', [['view', 'View laundry'], ['manage', 'Manage laundry orders']]),
  ...M('maintenance', [['view', 'View maintenance'], ['create', 'Report maintenance issues'], ['approve', 'Approve maintenance requests'], ['assign', 'Assign maintenance work'], ['work', 'Update work progress'], ['verify', 'Verify completed work']]),
  ...M('assets', [['view', 'View assets'], ['manage', 'Manage assets']]),
  ...M('outlets', [['view', 'View outlets (restaurants, bars, clubs)'], ['manage', 'Manage outlets, tables & kitchens']]),
  ...M('menus', [['view', 'View menus'], ['manage', 'Manage menus, items & recipes']]),
  ...M('pos', [['view', 'Access POS'], ['create_order', 'Create orders'], ['modify_order', 'Modify orders'], ['cancel_order', 'Cancel orders'], ['void_item', 'Void items'], ['discount', 'Apply POS discounts'], ['refund', 'Issue refunds'], ['settle', 'Settle bills / receive payments'], ['room_charge', 'Charge to room'], ['open_shift', 'Open cashier shift'], ['close_shift', 'Close cashier shift'], ['approve_variance', 'Approve cash variances'], ['reprint', 'Reprint receipts'], ['transfer', 'Transfer tables/waiters']]),
  ...M('kitchen', [['view', 'View kitchen display'], ['update', 'Update kitchen order status']]),
  ...M('clubs', [['view', 'View club events & tickets'], ['manage', 'Manage club events'], ['sell_tickets', 'Sell tickets / entries']]),
  ...M('events', [['view', 'View events & venues'], ['manage', 'Manage events, quotations & bookings']]),
  ...M('services', [['view', 'View services (spa, transfers...)'], ['manage', 'Manage services'], ['book', 'Book services']]),
  ...M('products', [['view', 'View products'], ['manage', 'Manage products & categories']]),
  ...M('stores', [['view', 'View stores'], ['manage', 'Manage stores']]),
  ...M('inventory', [['view', 'View stock & ledger'], ['issue', 'Issue stock to departments'], ['transfer', 'Transfer stock between stores'], ['adjust', 'Create stock adjustments'], ['approve_adjustment', 'Approve stock adjustments'], ['stocktake', 'Perform stocktakes'], ['approve_stocktake', 'Approve stocktakes'], ['waste', 'Record waste'], ['approve_waste', 'Approve waste'], ['valuation', 'View stock valuation']]),
  ...M('suppliers', [['view', 'View suppliers'], ['manage', 'Manage suppliers']]),
  ...M('requisitions', [['view', 'View requisitions'], ['create', 'Create requisitions'], ['approve', 'Approve requisitions']]),
  ...M('purchases', [['view', 'View purchase orders'], ['create', 'Create purchase orders'], ['approve', 'Approve purchase orders'], ['receive', 'Receive goods (GRN)'], ['invoice', 'Record supplier invoices'], ['quotations', 'Manage supplier quotations']]),
  ...M('expenses', [['view', 'View expenses'], ['create', 'Create expenses'], ['approve', 'Approve expenses'], ['pay', 'Pay expenses']]),
  ...M('petty_cash', [['view', 'View petty cash'], ['manage', 'Manage petty cash funds & transactions'], ['reconcile', 'Reconcile & replenish petty cash']]),
  ...M('payments', [['view', 'View payments'], ['create', 'Receive payments'], ['refund', 'Issue payment refunds'], ['pay_supplier', 'Pay suppliers'], ['approve_supplier_payment', 'Approve supplier payments']]),
  ...M('receivables', [['view', 'View receivables'], ['manage', 'Manage credit customers & invoices']]),
  ...M('payables', [['view', 'View payables']]),
  ...M('accounting', [['view', 'View accounting'], ['post', 'Post journals'], ['reverse', 'Reverse journals'], ['accounts', 'Manage chart of accounts'], ['periods', 'Open/close accounting periods'], ['night_audit', 'Run night audit / business day']]),
  ...M('reports', [['view', 'View reports'], ['export', 'Export reports'], ['financial', 'View financial reports']]),
  ...M('dashboard', [['view', 'View dashboard'], ['management', 'View management KPIs']]),
  ...M('approvals', [['view', 'View approval requests'], ['act', 'Approve/reject approval requests']]),
  ...M('imports', [['run', 'Import master data']]),
  ...M('attachments', [['upload', 'Upload attachments'], ['delete', 'Delete attachments']]),
];

export const PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

// Limit codes used by authority_limits
export const LIMIT_CODES = {
  DISCOUNT_PERCENT: 'discount_percent',
  REFUND_AMOUNT: 'refund_amount',
  EXPENSE_APPROVAL: 'expense_approval_amount',
  PURCHASE_APPROVAL: 'purchase_approval_amount',
  CASH_VARIANCE: 'cash_variance_amount',
  FOLIO_ADJUSTMENT: 'folio_adjustment_amount',
} as const;
