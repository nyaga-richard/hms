'use client';
import React from 'react';
import { useParams } from 'next/navigation';
import { FolioView } from '@/components/pms/folio-view';
export default function FolioPage() { const { id } = useParams<{ id: string }>(); return <FolioView folioId={id} />; }
