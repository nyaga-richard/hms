'use client';
import React, { useRef, useState } from 'react';
import { Paperclip, Upload, Trash2, Download } from 'lucide-react';
import { api, del, download } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Section } from './page';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '@/lib/utils';
/** Generic attachments panel (documents, photos, signed cards) bound to any entity. */
export function Attachments({ entity, entityId, title = 'Attachments' }: { entity: string; entityId: string; title?: string }) {
  const { can } = useAuth(); const ref = useRef<HTMLInputElement>(null); const [desc, setDesc] = useState('');
  const { data, refetch } = useApi<any[]>('/attachments', { entity_type: entity, entity_id: entityId });
  const up = useAction(async (files: FileList) => { const fd = new FormData(); fd.append('entity_type', entity); fd.append('entity_id', entityId); if (desc) fd.append('description', desc); Array.from(files).forEach((f) => fd.append('files', f)); return api('/attachments', { method: 'POST', formData: fd }); }, { success: 'Uploaded', onSuccess: () => { setDesc(''); refetch(); } });
  const rm = useAction((id: string) => del(`/attachments/${id}`), { success: 'Attachment deleted', onSuccess: () => refetch() });
  const rows = data ?? [];
  return <Section title={<span className="flex items-center gap-2"><Paperclip className="h-4 w-4" />{title} <span className="text-xs text-muted-foreground">({rows.length})</span></span>} actions={can('attachments.upload') && <><input ref={ref} type="file" multiple className="hidden" onChange={(e) => e.target.files?.length && up.mutate(e.target.files)} /><Button size="sm" variant="outline" loading={up.isPending} onClick={() => ref.current?.click()}><Upload />Upload</Button></>}>
    {rows.length === 0 ? <p className="text-sm text-muted-foreground">No files attached.</p> : <ul className="divide-y text-sm">{rows.map((a) => <li key={a.id} className="flex items-center justify-between py-1.5 gap-2"><div className="min-w-0"><div className="truncate font-medium">{a.file_name}</div><div className="text-xs text-muted-foreground">{(a.size_bytes / 1024).toFixed(0)} KB · {a.uploaded_by_name ?? '—'} · {fmtDateTime(a.created_at)}{a.description ? ` · ${a.description}` : ''}</div></div><div className="flex gap-1 shrink-0"><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => download(`/attachments/${a.id}/download`, {}, a.file_name)} aria-label="Download"><Download className="h-3.5 w-3.5" /></Button>{can('attachments.delete') && <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => rm.mutate(a.id)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}</div></li>)}</ul>}
  </Section>;
}
