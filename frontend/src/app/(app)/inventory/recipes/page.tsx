'use client';
import React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Badge } from '@/components/ui/badge';
import { fmtMoney, fmtNum } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
/** Recipe costing overview: every menu item with a recipe, its ingredient cost at current average cost and food-cost %. Editing happens in POS → Menus. */
export default function RecipesPage() {
  const { currency } = useAuth();
  return <div className="space-y-4">
    <PageHeader title="Recipes & costing" subtitle="Ingredient cost is recalculated from current average stock cost; POS sales consume ingredients automatically from the outlet store." actions={<Link href="/pos/menus" className="text-sm underline">Edit recipes in Menus →</Link>} />
    <DataTable path="/recipes" defaultSort="menu_item_name" defaultOrder="asc" exportName="recipe_costing" columns={[{ key: 'menu_item_name', label: 'Menu item' }, { key: 'version', label: 'Version', type: 'number', decimals: 0 }, { key: 'yield_qty', label: 'Yield', type: 'number', decimals: 2 }, { key: 'selling_price', label: 'Selling price', type: 'money' }, { key: 'cost', label: 'Ingredient cost', type: 'money' }, { key: 'cost_percent', label: 'Cost %', render: (r) => { const p = Number(r.cost_percent ?? 0); return <Badge tone={p > 40 ? 'destructive' : p > 30 ? 'warning' : 'success'}>{fmtNum(p, 1)}%</Badge>; } }, { key: 'effective_from', label: 'Effective', type: 'date' }]} />
  </div>;
}
