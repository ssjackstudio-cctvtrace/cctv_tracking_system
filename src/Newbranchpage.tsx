import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { supabase } from './lib/supabase'
import './Branches.css'
import './Newbranch.css'

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
// Advanced markers need a map ID. DEMO_MAP_ID works for development;
// create your own in Google Cloud and set VITE_GOOGLE_MAP_ID for production.
const MAP_ID = (import.meta.env.VITE_GOOGLE_MAP_ID as string | undefined) || 'DEMO_MAP_ID'
const DEFAULT_CENTER = { lat: 3.139, lng: 101.6869 }

// ---- Google Maps script loader (loads once) ----
let mapsLoader: Promise<void> | null = null
function loadGoogleMaps(): Promise<void> {
  if (!MAPS_KEY) return Promise.reject(new Error('Missing VITE_GOOGLE_MAPS_API_KEY in .env'))
  if (mapsLoader) return mapsLoader
  mapsLoader = new Promise<void>((resolve, reject) => {
    if (typeof google !== 'undefined' && typeof google.maps?.importLibrary === 'function') {
      resolve()
      return
    }
    // Google calls this function once the API is fully ready (importLibrary exists)
    ;(window as unknown as Record<string, () => void>).__onGoogleMapsReady = () => resolve()

    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&v=weekly&loading=async&callback=__onGoogleMapsReady`
    s.async = true
    s.onerror = () => {
      mapsLoader = null
      reject(new Error('Google Maps could not be loaded. Check the API key and your connection.'))
    }
    document.head.appendChild(s)
  })
  return mapsLoader
}

// Map marker: a dot with the branch name above it
function pinContent(name: string) {
  const wrap = document.createElement('div')
  wrap.className = 'nb-pin'
  const label = document.createElement('span')
  label.className = 'nb-pin-label'
  label.textContent = name.trim() || 'New branch'
  const dot = document.createElement('span')
  dot.className = 'nb-pin-dot'
  wrap.append(label, dot)
  return wrap
}

type TextKey = 'house_unit' | 'street' | 'township' | 'postal_code' | 'city' | 'state' | 'country'

type Details = Record<TextKey, string> & {
  google_place_id: string
  latitude: number | null
  longitude: number | null
}

const EMPTY: Details = {
  house_unit: '',
  street: '',
  township: '',
  postal_code: '',
  city: '',
  state: '',
  country: '',
  google_place_id: '',
  latitude: null,
  longitude: null,
}

// Auto-filled from Google, but editable in case Google leaves something blank
const EDITABLE: { key: TextKey; label: string; optional?: boolean }[] = [
  { key: 'house_unit', label: 'House / unit', optional: true },
  { key: 'street', label: 'Street', optional: true },
  { key: 'township', label: 'Township', optional: true },
  { key: 'postal_code', label: 'Postal code' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'country', label: 'Country', optional: true },
]

const pad = (n: number) => String(n).padStart(2, '0')
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const orNull = (v: string) => (v.trim() === '' ? null : v.trim())

// Full address: house / unit → country, skipping any part that is empty
const buildAddress = (d: Record<TextKey, string>) =>
  [d.house_unit, d.street, d.township, d.postal_code, d.city, d.state, d.country]
    .map((v) => v.trim())
    .filter(Boolean)
    .join(', ')

type Notice = { type: 'success' | 'error'; text: string }

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  )
}

function BranchPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 21h11M5 21V7l7-4 7 4v5M9 21v-6h4v6" />
      <path d="M19 15v6M16 18h6" />
    </svg>
  )
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m7.5 12.5 3 3 6-7" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 8.5 7 7M15.5 8.5l-7 7" />
    </svg>
  )
}

export default function NewBranchPage({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState('')
  const [details, setDetails] = useState<Details>(EMPTY)
  const [createdAt, setCreatedAt] = useState(todayStr)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [mapError, setMapError] = useState('')

  const mapDiv = useRef<HTMLDivElement>(null)
  const autocompleteDiv = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null)
  const nameRef = useRef('')

  // Keep the marker label in sync with the branch name
  useEffect(() => {
    nameRef.current = name
    if (markerRef.current) markerRef.current.content = pinContent(name)
  }, [name])

  // Set up the map + address autocomplete
  useEffect(() => {
    let cancelled = false
    let autocomplete: google.maps.places.PlaceAutocompleteElement | null = null

    ;(async () => {
      try {
        await loadGoogleMaps()
        const [{ Map }, { AdvancedMarkerElement }, { PlaceAutocompleteElement }] = await Promise.all([
          google.maps.importLibrary('maps') as Promise<google.maps.MapsLibrary>,
          google.maps.importLibrary('marker') as Promise<google.maps.MarkerLibrary>,
          google.maps.importLibrary('places') as Promise<google.maps.PlacesLibrary>,
        ])
        if (cancelled || !mapDiv.current || !autocompleteDiv.current) return

        const map = new Map(mapDiv.current, {
          center: DEFAULT_CENTER,
          zoom: 11,
          mapId: MAP_ID,
          mapTypeControl: false,
          streetViewControl: false,
        })
        mapRef.current = map

        autocomplete = new PlaceAutocompleteElement({})
        autocomplete.style.width = '100%'
        autocomplete.style.colorScheme = 'light'
        autocompleteDiv.current.replaceChildren(autocomplete)

        autocomplete.addEventListener('gmp-select', async ({ placePrediction }) => {
          const place = placePrediction.toPlace()
          await place.fetchFields({
            fields: ['id', 'location', 'addressComponents'],
          })
          if (cancelled || !place.location) return

          const comps = place.addressComponents ?? []
          const get = (...types: string[]) => {
            for (const t of types) {
              const c = comps.find((x) => x.types.includes(t))
              if (c?.longText) return c.longText
            }
            return ''
          }

          setDetails({
            house_unit: [get('subpremise'), get('street_number')].filter(Boolean).join(', '),
            street: get('route'),
            township: get('sublocality_level_1', 'sublocality', 'neighborhood'),
            postal_code: get('postal_code'),
            city: get('locality', 'postal_town', 'administrative_area_level_2'),
            state: get('administrative_area_level_1'),
            country: get('country'),
            google_place_id: place.id ?? '',
            latitude: place.location.lat(),
            longitude: place.location.lng(),
          })

          // Drop (or move) the labelled marker on the chosen address
          if (!markerRef.current) {
            markerRef.current = new AdvancedMarkerElement({
              map,
              position: place.location,
              content: pinContent(nameRef.current),
            })
          } else {
            markerRef.current.position = place.location
          }
          map.setCenter(place.location)
          map.setZoom(17)
        })
      } catch (err) {
        if (!cancelled) setMapError(err instanceof Error ? err.message : 'Google Maps failed to load.')
      }
    })()

    return () => {
      cancelled = true
      autocomplete?.remove()
      if (markerRef.current) markerRef.current.map = null
      markerRef.current = null
      mapRef.current = null
    }
  }, [])

  // After a successful save, go back to the branch list
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(onBack, 1500)
    return () => clearTimeout(t)
  }, [saved, onBack])

  const fullAddress = buildAddress(details)

  const fail = (text: string) => setNotice({ type: 'error', text })

  async function handleSave() {
    setNotice(null)
    const branch_name = name.trim()
    const postal_code = details.postal_code.trim()
    const city = details.city.trim()
    const state = details.state.trim()

    if (!branch_name) return fail('Enter the branch name.')
    if (details.latitude === null || details.longitude === null || !fullAddress)
      return fail('Search for the address and pick it from the list.')
    if (!postal_code || !city || !state)
      return fail('Postal code, city and state are required. Fill in the ones Google left blank.')
    if (!createdAt) return fail('Choose the date created.')

    // Default date (today) = save the exact current time; a chosen date = start of that day
    const created_at =
      createdAt === todayStr() ? new Date().toISOString() : new Date(`${createdAt}T00:00:00`).toISOString()

    setSaving(true)
    const { error } = await supabase.from('branch').insert({
      branch_name,
      house_unit: orNull(details.house_unit),
      street: orNull(details.street),
      township: orNull(details.township),
      formatted_address: fullAddress,
      postal_code,
      city,
      state,
      country: orNull(details.country),
      google_place_id: details.google_place_id || null,
      latitude: details.latitude,
      longitude: details.longitude,
      created_at,
    })
    setSaving(false)

    if (error) return fail(`Failed to save the branch ${branch_name}: ${error.message}`)

    setSaved(true)
    setNotice({ type: 'success', text: `The branch ${branch_name} is saved successfully` })
  }

  const setText = (key: TextKey) => (e: ChangeEvent<HTMLInputElement>) =>
    setDetails((prev) => ({ ...prev, [key]: e.target.value }))

  return (
    <>
      <button type="button" className="bc-btn nb-back" onClick={onBack}>
        <ArrowLeftIcon />
        Back to Branch Menu
      </button>

      <h1 className="nb-title">
        <BranchPlusIcon />
        New Branch
      </h1>
      <p className="ds-lead">Search the address and the details are filled in for you.</p>

      {notice && (
        <p className={`bp-notice bp-notice-${notice.type}`} role="status">
          {notice.type === 'success' ? <TickIcon /> : <CrossIcon />}
          <span>{notice.text}</span>
        </p>
      )}

      <section className="ds-panel nb-panel">
        <label className="nb-field">
          <span>Branch name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jack Studio Shah Alam" />
        </label>

        <div className="nb-field">
          <span>Address</span>
          <div ref={autocompleteDiv} className="nb-autocomplete">
            {!mapError && <small className="nb-hint">Loading address search…</small>}
          </div>
        </div>

        {mapError ? (
          <p className="ds-error">{mapError}</p>
        ) : (
          <div ref={mapDiv} className="nb-map" aria-label="Map" />
        )}

        <div className="nb-grid">
          <label className="nb-field nb-span2">
            <span>Full address</span>
            <input readOnly value={fullAddress} placeholder="Filled in from the address you select" />
          </label>

          {EDITABLE.map(({ key, label, optional }) => (
            <label className="nb-field" key={key}>
              <span>
                {label}
                {optional ? ' (optional)' : ''}
              </span>
              <input readOnly value={details[key]} onChange={setText(key)} />
            </label>
          ))}

          <label className="nb-field">
            <span>Google place ID</span>
            <input readOnly value={details.google_place_id} />
          </label>
          <label className="nb-field">
            <span>Latitude</span>
            <input readOnly value={details.latitude ?? ''} />
          </label>
          <label className="nb-field">
            <span>Longitude</span>
            <input readOnly value={details.longitude ?? ''} />
          </label>

          <label className="nb-field">
            <span>Date created</span>
            <input type="date" value={createdAt} onChange={(e) => setCreatedAt(e.target.value)} />
          </label>
        </div>
      </section>

      <div className="nb-footer">
        <button type="button" className="nb-save" disabled={saving || saved} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save branch'}
        </button>
      </div>
    </>
  )
}