'use client';
import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { post } from '@/lib/api';
import { useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ResourcePage } from '@/components/shared/resource-page';
import { FormDialog } from '@/components/shared/form';
import { DropdownMenuItem } from '@/components/ui/dropdown';
import { StatusBadge } from '@/components/ui/badge';
/** In-room inventory (TVs, kettles, linen, minibar items): per-room register with damage/missing events that can charge the guest. */
export default function RoomItemsPage() {
  const { can } = useAuth(); const [ev, setEv] = useState<any>(null);
  const evM = useAction((v: any) => post(`/room-items/${ev.id}/event`, v), { success: 'Event recorded', invalidate: ['/room-items', '/folios'] });
  return <div className="space-y-4"><Tabs defaultValue="items"><TabsList><TabsTrigger value="items">Room items</TabsTrigger><TabsTrigger value="types">Item types</TabsTrigger></TabsList>
    <TabsContent value="items"><ResourcePage title="Room items" subtitle="Inventory placed in rooms; report missing/damaged items and charge guests where applicable." path="/room-items" permissions={{ create: 'rooms.items', edit: 'rooms.items' }} filters={[{ key: 'room_id', label: 'Room', type: 'select', source: '/rooms', sourceLabel: 'number', sourceQuery: { pageSize: 500, sort: 'number', order: 'asc' } }, { key: 'condition', label: 'Condition', type: 'select', options: ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'] }]}
      columns={[{ key: 'room_number', label: 'Room' }, { key: 'item_name', label: 'Item' }, { key: 'category', label: 'Category' }, { key: 'quantity', label: 'Qty', type: 'number', decimals: 0 }, { key: 'serial_number', label: 'Serial' }, { key: 'condition', label: 'Condition', render: (r) => <StatusBadge status={r.condition} /> }, { key: 'replacement_value', label: 'Replacement value', type: 'money' }]}
      fields={[{ name: 'room_id', label: 'Room', type: 'lookup', source: '/rooms', sourceLabel: 'number', sourceQuery: { pageSize: 500, sort: 'number', order: 'asc' }, required: true }, { name: 'item_type_id', label: 'Item type', type: 'lookup', source: '/room-item-types', required: true }, { name: 'quantity', label: 'Quantity', type: 'number', default: 1 }, { name: 'condition', label: 'Condition', type: 'select', options: ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'], default: 'GOOD' }, { name: 'serial_number', label: 'Serial number' }, { name: 'asset_number', label: 'Asset number' }, { name: 'purchase_date', label: 'Purchase date', type: 'date' }, { name: 'cost', label: 'Cost', type: 'money' }, { name: 'notes', label: 'Notes', type: 'textarea', col: 2 }]}
      extraActions={(row) => can('rooms.items') && <DropdownMenuItem onClick={() => setEv(row)}><AlertTriangle />Report event…</DropdownMenuItem>} /></TabsContent>
    <TabsContent value="types"><ResourcePage title="Room item types" path="/room-item-types" permissions={{ create: 'rooms.items', edit: 'rooms.items' }} columns={[{ key: 'name', label: 'Name' }, { key: 'category', label: 'Category' }, { key: 'standard_quantity', label: 'Std qty', type: 'number', decimals: 0 }, { key: 'replacement_value', label: 'Replacement value', type: 'money' }, { key: 'is_serialized', label: 'Serialized', type: 'boolean' }, { key: 'is_consumable', label: 'Consumable', type: 'boolean' }, { key: 'is_active', label: 'Active', type: 'boolean' }]}
      fields={[{ name: 'name', label: 'Name', required: true }, { name: 'category', label: 'Category', type: 'select', options: ['AMENITY', 'ELECTRONICS', 'FURNITURE', 'LINEN', 'MINIBAR', 'BATHROOM', 'SAFETY', 'OTHER'], default: 'AMENITY' }, { name: 'standard_quantity', label: 'Standard quantity', type: 'number', default: 1 }, { name: 'replacement_value', label: 'Replacement value', type: 'money' }, { name: 'product_id', label: 'Linked product (consumables)', type: 'lookup', source: '/products' }, { name: 'is_serialized', label: 'Serialized', type: 'switch' }, { name: 'is_consumable', label: 'Consumable', type: 'switch' }, { name: 'is_active', label: 'Active', type: 'switch', default: true }]} /></TabsContent>
  </Tabs>
    <FormDialog open={!!ev} onOpenChange={(o) => !o && setEv(null)} title={`Report event · ${ev?.item_name} (Room ${ev?.room_number})`} size="sm" cols={1} initial={{ quantity: 1, event_type: 'DAMAGED' }} fields={[{ name: 'event_type', label: 'Event', type: 'select', options: ['MISSING', 'BROKEN', 'DAMAGED', 'REPLACED', 'GUEST_DAMAGE', 'CONSUMED', 'RETURNED'], required: true }, { name: 'quantity', label: 'Quantity', type: 'number', min: 1 }, { name: 'charge_guest', label: 'Charge in-house guest', type: 'switch' }, { name: 'charge_amount', label: 'Charge amount (defaults to replacement value)', type: 'money' }, { name: 'notes', label: 'Notes', type: 'textarea' }]} onSubmit={(v) => evM.mutateAsync(v)} />
  </div>;
}
