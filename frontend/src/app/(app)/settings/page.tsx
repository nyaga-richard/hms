'use client';
import React from 'react';
import Link from 'next/link';
import { Building2, Users, Shield, GitBranch, BedDouble, Tags, Briefcase, Upload, ScrollText, Server, SlidersHorizontal, Landmark, ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';

const CARDS = [
  { href: '/settings/general', icon: SlidersHorizontal, title: 'Hotel settings', desc: 'Check-in/out times, policies, deposit rules, document numbering.', perms: ['settings.view'] },
  { href: '/settings/properties', icon: Building2, title: 'Company & properties', desc: 'Legal entity, properties, currency, timezone, contact details.', perms: ['properties.view'] },
  { href: '/settings/rooms', icon: BedDouble, title: 'Room types & rooms', desc: 'Room categories, occupancy, base rates, amenities and physical rooms.', perms: ['room_types.view'] },
  { href: '/settings/rates', icon: Tags, title: 'Rate plans & packages', desc: 'Seasonal pricing, day-of-week rates, meal plans, package components, corporate rates.', perms: ['room_types.view'] },
  { href: '/settings/users', icon: Users, title: 'Users', desc: 'Accounts, role assignment, property access, permission overrides, sessions.', perms: ['users.view'] },
  { href: '/settings/roles', icon: Shield, title: 'Roles & permissions', desc: 'Granular permission matrix and authority limits (discounts, approvals, refunds).', perms: ['roles.view'] },
  { href: '/settings/workflows', icon: GitBranch, title: 'Approval workflows', desc: 'Who approves what, by amount band and step — requisitions, POs, payments, expenses.', perms: ['settings.workflows'] },
  { href: '/settings/departments', icon: Briefcase, title: 'Departments', desc: 'Cost centres used across expenses, requisitions and journals.', perms: ['departments.view'] },
  { href: '/finance/setup', icon: Landmark, title: 'Finance setup', desc: 'Taxes, payment methods, currencies, accounting periods.', perms: ['settings.view', 'accounting.view'] },
  { href: '/settings/import', icon: Upload, title: 'Data import', desc: 'CSV templates for guests, rooms, products, suppliers, menu items, opening stock.', perms: ['imports.run'] },
  { href: '/settings/audit', icon: ScrollText, title: 'Audit trail', desc: 'Who did what, when, from where — across every module.', perms: ['audit.view'] },
  { href: '/settings/system', icon: Server, title: 'System & backups', desc: 'Environment, database, storage, on-demand backups.', perms: ['settings.view', 'settings.backup'] },
];
export default function SettingsHub() {
  const { can } = useAuth();
  return <div className="space-y-4"><PageHeader title="Settings & administration" subtitle="Everything about how this hotel runs is configuration, not code." /><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{CARDS.filter((c) => can(...c.perms)).map((c) => <Link key={c.href} href={c.href} className="group flex items-start gap-3 rounded-lg border bg-card p-4 transition hover:border-primary/50 hover:bg-accent/40"><c.icon className="mt-0.5 h-5 w-5 text-primary" /><div className="min-w-0 flex-1"><div className="font-medium">{c.title}</div><div className="text-xs text-muted-foreground">{c.desc}</div></div><ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" /></Link>)}</div></div>;
}
