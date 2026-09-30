import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import BranchesPage from './BranchesPage'
import BranchFormPage from './Branchformpage'
import CameraPage from './Camerapage'
import EventsPage, { CctvEventsTable } from './Eventspage'
import VisitsPage from './Visitspage'
import TransactionsPage from './Transactionspage'
import NewBranchPage from './NewBranchPage'
import './dashboard.css'

type PageKey = 'dashboard' | 'branch' | 'camera' | 'events' | 'visits' | 'transactions'
// Sub-pages of Branch (sidebar keeps "Branch" highlighted on these)
type ViewKey = PageKey | 'branchAdd' | 'branchManage'

const SUB_TITLES: Partial<Record<ViewKey, string>> = {
  branchAdd: 'Add Branch',
  branchManage: 'Branch Management',
}

const NAV: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" /> },
  { key: 'branch', label: 'Branch', icon: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" /> },
  { key: 'camera', label: 'Camera', icon: <path d="M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /> },
  { key: 'events', label: 'Event', icon: <path d="M13 2 4 14h7l-1 8 9-12h-7z" /> },
  { key: 'visits', label: 'Visit', icon: <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /> },
  { key: 'transactions', label: 'Transaction', icon: <path d="M3 7h16l-4-4M21 17H5l4 4" /> },
]

function Logo() {
  return (
    <svg className="ds-logo" viewBox="465 130 270 270" aria-hidden="true">
      <rect x="465" y="130" width="270" height="270" rx="58" fill="#ffffff" />
      <g fill="none" stroke="#111111" strokeWidth="13" strokeLinejoin="miter">
        <path d="M562 158A113 113 0 0 1 712 292" />
        <path d="M668 352A113 113 0 0 1 487 240" />
        <path d="M512 208L538 178L668 352" />
      </g>
    </svg>
  )
}

const countOf = (table: string) => supabase.from(table).select('*', { count: 'exact', head: true })

function Overview() {
  const [counts, setCounts] = useState<(number | null)[]>([null, null, null, null])
  const [error, setError] = useState('')

  useEffect(() => {
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)

    Promise.all([
      countOf(TABLES.branch),
      countOf(TABLES.camera).eq('active_status', 'Active'),
      countOf(TABLES.cctvEvent).gte('event_time', startOfToday.toISOString()),
      countOf(TABLES.transaction),
    ]).then((results) => {
      setCounts(results.map((r) => (r.error ? null : r.count)))
      const failed = results.find((r) => r.error)
      if (failed?.error) setError(failed.error.message)
    })
  }, [])

  const stats = ['Branches', 'Active cameras', 'CCTV events today', 'Transactions']

  return (
    <>
      <h1>Dashboard</h1>
      <p className="ds-lead">Overview of your branches and cameras.</p>
      {error && <p className="ds-error">Some numbers failed to load: {error}</p>}
      <section className="ds-stats">
        {stats.map((label, i) => (
          <div className="ds-stat" key={label}>
            <small>{label}</small>
            <strong>{counts[i] ?? '—'}</strong>
          </div>
        ))}
      </section>
      <section className="ds-panel">
        <h2>Recent CCTV events</h2>
        <CctvEventsTable limit={5} />
      </section>
    </>
  )
}

export default function Dashboard() {
  const [page, setPage] = useState<ViewKey>('dashboard')
  const [branchId, setBranchId] = useState<string | null>(null)
  const activeNav: PageKey = page === 'branchAdd' || page === 'branchManage' ? 'branch' : page

  useEffect(() => {
    const label = SUB_TITLES[page] ?? NAV.find((n) => n.key === page)?.label
    document.title = label ? `${label} | JackStudio CCTV Tracking` : 'JackStudio CCTV Tracking'
  }, [page])

  return (
    <div className="ds">
      <aside className="ds-side">
        <div
          className="ds-brand"
          role="button"
          tabIndex={0}
          aria-label="Go to dashboard"
          style={{ cursor: 'pointer' }}
          onClick={() => setPage('dashboard')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setPage('dashboard')
            }
          }}
        >
          <Logo />
          <div>
            <div className="ds-brand-name">JackStudio</div>
            <div className="ds-brand-sub">CCTV Tracking</div>
          </div>
        </div>

        <nav className="ds-nav" aria-label="Main">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={activeNav === n.key ? 'active' : ''}
              aria-current={activeNav === n.key ? 'page' : undefined}
              onClick={() => setPage(n.key)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">{n.icon}</svg>
              {n.label}
            </button>
          ))}
        </nav>

        <div className="ds-live"><i /> System online</div>
      </aside>

      <main className="ds-main">
        {page === 'dashboard' && <Overview />}
        {page === 'branch' && (
          <BranchesPage
            onAdd={() => setPage('branchAdd')}
            onManage={(id) => {
              setBranchId(id)
              setPage('branchManage')
            }}
          />
        )}
        {page === 'branchAdd' && <NewBranchPage onBack={() => setPage('branch')} />}
        {page === 'branchManage' && <BranchFormPage branchId={branchId} onBack={() => setPage('branch')} />}
        {page === 'camera' && <CameraPage />}
        {page === 'events' && <EventsPage />}
        {page === 'visits' && <VisitsPage />}
        {page === 'transactions' && <TransactionsPage />}
      </main>
    </div>
  )
}