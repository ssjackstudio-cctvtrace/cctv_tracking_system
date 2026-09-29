import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const secretKey = process.env.SUPABASE_SECRET_KEY

if (!url || !secretKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env')
  process.exit(1)
}

// The secret key has full access and bypasses RLS.
// Use it in server-side scripts only, never in frontend code.
const supabase = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ---------------- INSERT (disabled) ----------------
// const { data, error } = await supabase
//   .from('branch')
//   .insert({
//     branch_name: 'TEST Branch',
//     formatted_address: 'Jalan Test, 50000 Kuala Lumpur, Malaysia',
//     postal_code: '50000',
//     city: 'Kuala Lumpur',
//     state: 'Wilayah Persekutuan',
//     google_place_id: 'test-place-id',
//     latitude: 3.139,
//     longitude: 101.6869,
//   })
//   .select()
//   .single()
//
// if (error) {
//   console.error('❌ INSERT failed')
//   console.error('  ', [error.code, error.message, error.hint].filter(Boolean).join(' | '))
//   process.exit(1)
// }
//
// console.log('✅ INSERT succeeded. New row:')
// console.log(data)

// ---------------- UPDATE ----------------
const { data, error } = await supabase
  .from('branch')
  .update({
    formatted_address: 'Jalan Updated, 50450 Kuala Lumpur, Malaysia',
    postal_code: '50450',
    latitude: 3.1478,
    longitude: 101.6953,
    created_at: new Date().toISOString(), // current time (UTC)
  })
  .eq('branch_name', 'TEST Branch') // filter: which row(s) to update
  .select()
  .single()

if (error) {
  console.error('❌ UPDATE failed')
  console.error('  ', [error.code, error.message, error.hint].filter(Boolean).join(' | '))
  process.exit(1)
}

console.log('✅ UPDATE succeeded. Updated row:')
console.log(data)