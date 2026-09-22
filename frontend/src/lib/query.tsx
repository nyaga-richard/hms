'use client';
import React from 'react';
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { toast } from 'sonner';
import { get, ApiError } from './api';
const client = new QueryClient({ defaultOptions: { queries: { retry: (n, e: any) => (e?.status >= 500 ? n < 1 : false), staleTime: 15_000, refetchOnWindowFocus: false } } });
export function QueryProvider({ children }: { children: React.ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
/** Fetch helper bound to the API; key is the path + query. */
export function useApi<T = any>(path: string | null, query?: Record<string, any>, opts?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({ queryKey: [path, query ?? {}], queryFn: () => get<T>(path!, query), enabled: !!path && (opts?.enabled ?? true), ...(opts as any) });
}
/** Mutation helper with toast feedback and cache invalidation of related paths. */
export function useAction<TArgs = any, TRes = any>(fn: (args: TArgs) => Promise<TRes>, opts: { success?: string | ((r: TRes) => string); invalidate?: (string | ((r: TRes) => string))[]; onSuccess?: (r: TRes, args: TArgs) => void; onError?: (e: ApiError, args: TArgs) => void; silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation<TRes, ApiError, TArgs>({
    mutationFn: fn,
    onSuccess: (r, args) => {
      if (!opts.silent) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success ?? 'Done');
      (opts.invalidate ?? []).forEach((p) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith(typeof p === 'function' ? p(r) : p) }));
      opts.onSuccess?.(r, args);
    },
    onError: (e, args) => { opts.onError?.(e, args); toast.error(e.message || 'Request failed', { description: e.code !== 'VALIDATION_ERROR' && e.details && typeof e.details !== 'object' ? String(e.details) : Array.isArray(e.details) ? e.details.map((d: any) => `${d.path}: ${d.message}`).join('\n') : undefined }); },
  });
}
export function useInvalidate() { const qc = useQueryClient(); return (...prefixes: string[]) => prefixes.forEach((p) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith(p) })); }
