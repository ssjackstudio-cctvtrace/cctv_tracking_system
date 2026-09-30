import DataTable, { Badge } from './Datatable'
import { TABLES, useTable, shortId } from './Usetable'
import type { Branch, Visit } from './types'

export default function VisitsPage() {
  const visits = useTable<Visit>(TABLES.visit)
  const branches = useTable<Branch>(TABLES.branch, 'branch_name', true, 500)
  const branchName = (id: string) => branches.rows.find((b) => b.branch_id === id)?.branch_name ?? shortId(id)

  return (
    <>
      <h1>Visit</h1>
      <p className="ds-lead">People tracked walking into each branch.</p>
      <DataTable
        rows={visits.rows}
        loading={visits.loading}
        error={visits.error}
        emptyMessage="No visits found."
        rowKey={(r) => r.visit_id}
        columns={[
          { header: 'Visit', render: (r) => shortId(r.visit_id) },
          { header: 'Branch', render: (r) => branchName(r.branch_id) },
          { header: 'Track ID', render: (r) => r.track_id },
          { header: 'Type', render: (r) => <Badge text={r.visit_type} /> },
          { header: 'Gender (est.)', render: (r) => r.est_gender },
          { header: 'Age (est.)', render: (r) => r.est_age ?? '—' },
          { header: 'Demographic score', render: (r) => r.demongraphic_score ?? '—' },
        ]}
      />
    </>
  )
}