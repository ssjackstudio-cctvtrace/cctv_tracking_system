import DataTable, { Badge } from './Datatable'
import { TABLES, useTable, formatTime, shortId } from './Usetable'
import type { Transaction } from './types'

export default function TransactionsPage() {
  const t = useTable<Transaction>(TABLES.transaction, 'transaction_date', false)

  return (
    <>
      <h1>Transaction</h1>
      <p className="ds-lead">Purchases matched to CCTV events.</p>
      <DataTable
        rows={t.rows}
        loading={t.loading}
        error={t.error}
        emptyMessage="No transactions found."
        rowKey={(r) => r.transaction_id}
        columns={[
          { header: 'Date', render: (r) => formatTime(r.transaction_date) },
          { header: 'Transaction', render: (r) => shortId(r.transaction_id) },
          { header: 'CCTV event', render: (r) => shortId(r.matched_event_id) },
          { header: 'Amount (RM)', render: (r) => Number(r.amount).toFixed(2) },
          { header: 'Status', render: (r) => <Badge text={r.status} /> },
        ]}
      />
    </>
  )
}