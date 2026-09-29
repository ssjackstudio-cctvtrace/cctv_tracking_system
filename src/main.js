import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

const dbStatus = document.getElementById('db-status')
const tableStatus = document.getElementById('table-status')

function show(el, ok, message) {
  el.textContent = (ok ? '🟢 ' : '🔴 ') + message
  el.style.color = ok ? 'green' : 'red'
}

async function checkConnection() {
  if (!url || !key) {
    show(dbStatus, false, 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')
    return
  }

  try {
    const res = await fetch(`${url}/auth/v1/health`, { headers: { apikey: key } })
    if (res.ok) show(dbStatus, true, 'Connected to Supabase')
    else if (res.status === 401) show(dbStatus, false, 'Reached Supabase, but the API key is invalid')
    else show(dbStatus, false, `Supabase responded with status ${res.status}`)
  } catch (err) {
    show(dbStatus, false, 'Cannot reach Supabase: ' + err.message)
    return
  }

  // Optional: check that the tables exist
  const supabase = createClient(url, key)
  const { error } = await supabase.from('camera').select('camera_id').limit(1)

  if (!error) show(tableStatus, true, 'Table "camera" is readable')
  else if (error.code === 'PGRST205') show(tableStatus, false, 'Table "camera" not found. Run schema.sql first')
  else if (error.code === '42501') show(tableStatus, true, 'Table "camera" exists (access is restricted by RLS, as expected)')
  else show(tableStatus, false, 'Table check failed: ' + error.message)
}

checkConnection()