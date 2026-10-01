import { useCallback, useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import type {
  Branch,
  Camera,
  CctvEvent,
  EdgeDevice,
  Member,
  MemberFaceTemplate,
  RecognitionEvent,
  Transaction,
  Visit,
} from './types'

// Change a name here if your Supabase table is called something else
export const TABLES = {
  branch: 'branch',
  edgeDevice: 'edge_device',
  camera: 'camera',
  member: 'member',
  memberFaceTemplate: 'member_face_template',
  visit: 'visit',
  cctvEvent: 'cctv_event',
  recognitionEvent: 'recognition_event',
  transaction: 'transaction',
} as const

export type TableName = (typeof TABLES)[keyof typeof TABLES]

// Which row type belongs to which table
export type RowOf = {
  branch: Branch
  edge_device: EdgeDevice
  camera: Camera
  member: Member
  member_face_template: MemberFaceTemplate
  visit: Visit
  cctv_event: CctvEvent
  recognition_event: RecognitionEvent
  transaction: Transaction
}

// Primary key column of each table (used for update / delete)
export const PRIMARY_KEY: { [K in TableName]: keyof RowOf[K] & string } = {
  branch: 'branch_id',
  edge_device: 'edge_device_id',
  camera: 'camera_id',
  member: 'member_id',
  member_face_template: 'face_template_id',
  visit: 'visit_id',
  cctv_event: 'cctv_event_id',
  recognition_event: 'recognition_event_id',
  transaction: 'transaction_id',
}

// Sensible default sort column for each table (newest first).
// VISIT has no time column, so it is sorted by its id.
export const DEFAULT_ORDER: { [K in TableName]: keyof RowOf[K] & string } = {
  branch: 'created_at',
  edge_device: 'created_at',
  camera: 'created_at',
  member: 'joined_at',
  member_face_template: 'created_at',
  visit: 'visit_id',
  cctv_event: 'event_time',
  recognition_event: 'event_time',
  transaction: 'transaction_date',
}

// Loads rows from one table. Returns empty rows (not an error) when there is no data.
// Call reload() after an insert / update / delete to refresh the list.
export function useTable<T>(table: string, orderBy?: string, ascending = false, limit = 100) {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)

  const reload = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const base = supabase.from(table).select('*')
    const query = orderBy ? base.order(orderBy, { ascending }) : base
    query.limit(limit).then(({ data, error }) => {
      if (cancelled) return
      if (error) setError(error.message)
      else setRows((data ?? []) as T[])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [table, orderBy, ascending, limit, version])

  return { rows, loading, error, reload }
}

// Typed version: the row type and default sort come from the table name.
// Example: const { rows } = useTypedTable(TABLES.camera)   // rows: Camera[]
export function useTypedTable<K extends TableName>(
  table: K,
  orderBy: keyof RowOf[K] & string = DEFAULT_ORDER[table],
  ascending = false,
  limit = 100,
) {
  return useTable<RowOf[K]>(table, orderBy, ascending, limit)
}

// ---------- Insert / update / delete ----------
// Each returns an error message, or '' when it worked.

export async function insertRow<K extends TableName>(table: K, row: Partial<RowOf[K]>) {
  const { error } = await supabase.from(table).insert(row)
  return error ? error.message : ''
}

export async function updateRow<K extends TableName>(
  table: K,
  id: string,
  changes: Partial<RowOf[K]>,
) {
  const { error } = await supabase.from(table).update(changes).eq(PRIMARY_KEY[table], id)
  return error ? error.message : ''
}

export async function deleteRow<K extends TableName>(table: K, id: string) {
  const { error } = await supabase.from(table).delete().eq(PRIMARY_KEY[table], id)
  return error ? error.message : ''
}

// ---------- Formatting ----------
export const formatTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-MY') : '—'

export const shortId = (id: string | null) => (id ? id.slice(0, 8) : '—')

// Shows a 0–100 score such as match_score or confidence as "87.5%"
export const formatScore = (score: number | null) =>
  score === null || score === undefined ? '—' : `${Number(score).toFixed(1)}%`

// Shows an amount as Malaysian ringgit, e.g. "RM 1,250.00"
export const formatAmount = (amount: number | null) =>
  amount === null || amount === undefined
    ? '—'
    : new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(amount)

// True when a camera or edge box has reported within the last few minutes
export const isOnline = (lastSeen: string | null, withinMinutes = 5) =>
  !!lastSeen && Date.now() - new Date(lastSeen).getTime() < withinMinutes * 60_000