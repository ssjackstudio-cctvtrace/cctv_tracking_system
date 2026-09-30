// Placeholder for the Add Branch / Branch Management pages.
// Replace the panel below with your real form when you build it.
type Props = {
  branchId?: string | null // set = edit an existing branch, empty = add a new one
  onBack: () => void
}

export default function BranchFormPage({ branchId, onBack }: Props) {
  const isEdit = !!branchId

  return (
    <>
      <h1>{isEdit ? 'Branch Management' : 'Add Branch'}</h1>
      <p className="ds-lead">
        {isEdit ? 'View and edit this branch.' : 'Create a new branch.'}
      </p>
      <section className="ds-panel">
        <p className="ds-empty">
          {isEdit ? `Branch form goes here (branch id: ${branchId}).` : 'Branch form goes here.'}
        </p>
        <button className="bc-btn" onClick={onBack}>
          Back to branches
        </button>
      </section>
    </>
  )
}