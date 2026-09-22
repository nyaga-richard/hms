'use client';
import React, { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { post } from '@/lib/api';
import { useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormDialog } from '@/components/shared/form';
import { titleCase } from '@/lib/utils';
export default function OrdersPage() {
  const { can } = useAuth(); const [refund, setRefund] = useState<any>(null);
  const refundM = useAction((v: any) => post(`/orders/${refund.id}/refund`, { ...v, amount: Number(v.amount) }), { success: 'Refund posted', invalidate: ['/orders', '/payments'] });
  return <div className="space-y-4"><PageHeader title="Orders" subtitle="All outlet orders with settlement details. Refunds require the refund permission and are journaled." />
    <DataTable path="/orders" defaultSort="opened_at" searchPlaceholder="Search order number, table, guest…" rowHref={(r) => `/pos/orders/${r.id}`}
      filters={[{ key: 'outlet_id', label: 'Outlet', type: 'select', source: '/outlets' }, { key: 'status', label: 'Status', type: 'select', options: ['OPEN', 'BILLED', 'CLOSED', 'CANCELLED', 'REFUNDED'] }, { key: 'date', label: 'Business date', type: 'date' }]}
      columns={[{ key: 'number', label: 'Order' }, { key: 'business_date', label: 'Date', type: 'date' }, { key: 'outlet_name', label: 'Outlet' }, { key: 'type', label: 'Type', render: (r) => titleCase(r.type) }, { key: 'table_number', label: 'Table/Room', render: (r) => r.table_number ? `T${r.table_number}` : r.room_number ? `Rm ${r.room_number}` : '' }, { key: 'guest_name', label: 'Guest' }, { key: 'waiter_name', label: 'Waiter' }, { key: 'covers', label: 'Pax', type: 'number', decimals: 0 }, { key: 'total', label: 'Total', type: 'money' }, { key: 'settlement_type', label: 'Settlement', render: (r) => r.settlement_type ? <Badge tone="muted">{titleCase(r.settlement_type)}</Badge> : '' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { key: 'opened_at', label: 'Opened', type: 'datetime' }]}
      rowActions={(r) => r.status === 'CLOSED' && can('pos.refund') ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setRefund(r); }}><RotateCcw />Refund</Button> : null} />
    <FormDialog open={!!refund} onOpenChange={(o) => !o && setRefund(null)} title={`Refund order ${refund?.number}`} size="sm" cols={1} fields={[{ name: 'payment_method_id', label: 'Refund via', type: 'lookup', source: '/payment-methods', required: true }, { name: 'amount', label: 'Amount', type: 'money', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }, { name: 'reference', label: 'Reference' }]} onSubmit={(v) => refundM.mutateAsync(v)} />
  </div>;
}
