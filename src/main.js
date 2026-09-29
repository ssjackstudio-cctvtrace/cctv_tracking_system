import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

async function loadCameras() {
  const list = document.getElementById('camera-list')
  const { data, error } = await supabase.from('cameras').select('*')

  if (error) {
    list.textContent = 'Error: ' + error.message
    return
  }

  list.innerHTML = ''
  data.forEach((cam) => {
    const li = document.createElement('li')
    li.textContent = cam.name
    list.appendChild(li)
  })
}

loadCameras()