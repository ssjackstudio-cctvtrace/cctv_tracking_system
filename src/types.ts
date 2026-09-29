export type Branch = {
  branch_id: string // uuid
  branch_name: string
  house_unit: string | null
  street: string | null
  township: string | null
  formatted_address: string
  postal_code: string
  city: string
  state: string
  country: string | null
  google_place_id: string | null
  latitude: number
  longitude: number
  created_at: string
}

// The fields the admin can edit
export type BranchEditable = Pick<
  Branch,
  | 'branch_name'
  | 'house_unit'
  | 'street'
  | 'township'
  | 'formatted_address'
  | 'postal_code'
  | 'city'
  | 'state'
  | 'country'
>