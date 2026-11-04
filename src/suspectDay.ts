import { formatLongDate } from './Cameradetails'

// Date filter of Camera page → Suspicious same person (Suspects.tsx, StaffReview.tsx, StaffTrack.tsx)

const pad = (n: number) => String(n).padStart(2, '0')

// YYYY-MM-DD of today, in local time (Malaysia)
export const todayDay = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// "3 November 2026" (day = YYYY-MM-DD)
export const fmtDayLong = (day: string) => formatLongDate(new Date(`${day}T00:00:00`).toISOString())

// [start of the day, start of the next day] as ISO strings, in local time (day = YYYY-MM-DD)
export const dayRange = (day: string): [string, string] => {
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}

// "today", or "on 3 November 2026" for another date (for the section texts)
export const dayWords = (day: string) => (day === todayDay() ? 'today' : `on ${fmtDayLong(day)}`)
