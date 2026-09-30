import DataTable, { Badge } from './Datatable'
import { TABLES, useTable, shortId } from './Usetable'
import type { Branch, Camera } from './types'

export default function CameraPage() {
  const cams = useTable<Camera>(TABLES.camera, 'camera_name', true)
  const branches = useTable<Branch>(TABLES.branch, 'branch_name', true, 500)
  const branchName = (id: string) => branches.rows.find((b) => b.branch_id === id)?.branch_name ?? shortId(id)

  return (
    <>
      <h1>Camera</h1>
      <p className="ds-lead">Cameras installed at each branch.</p>
      <DataTable
        rows={cams.rows}
        loading={cams.loading}
        error={cams.error}
        emptyMessage="No cameras found."
        rowKey={(r) => r.camera_id}
        columns={[
          { header: 'Camera', render: (r) => r.camera_name },
          { header: 'Branch', render: (r) => branchName(r.branch_id) },
          { header: 'Status', render: (r) => <Badge text={r.active_status} /> },
        ]}
      />
    </>
  )
}