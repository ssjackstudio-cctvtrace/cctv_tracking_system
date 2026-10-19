import type { Point } from './types'
import type { RegionKind } from './space3d'

// Shop floor plans read from the shop drawings (Furniture Plan Layout, 1:35,
// dimensions in millimetres → metres here). Used by the 3D shop floor map as
// the starting plan until one is saved in branch.floor_plan.
//
// Floor plan axes (seen from above): X to the right, Y up the drawing,
// (0, 0) = the inside corner of the walls at the bottom left of the drawing.
// Facing: 0° = up the drawing (+Y), 90° = to the right (+X).

export type ShopRegion = {
  id: string
  name: string
  kind: RegionKind
  floor: Point[] // metres
  z_min: number
  z_max: number
}

export type ShopLayout = {
  outline: Point[] // walls + shop front, metres (inside = In)
  regions: ShopRegion[]
  cameras: Record<string, { x: number; y: number; yaw: number; tilt: number }>
}

// JackStudio @ Aeon Bukit Tinggi
//  - Walls: left 5860 mm, bottom 4208 mm, top 7314 mm; the shop front (glass,
//    entrance at the bottom right) runs diagonally from the bottom right
//    corner (4208, 0) to the top right corner (7314, 5860).
//  - Counter: the blue outline around the cashier counter, from x = 1050 mm
//    up to y = 2730 mm, then sloping down to the shop front at y = 2290 mm.
//  - Purchasing: the rest of the shop (display tables, wall cabinets).
//  - Outside Shop: the mall walkway in front of the shop front.
//  - Cameras (Tapo, 3.25 m high, in the 4 corners, facing the arrows):
//    ABT-01 top left, ABT-02 top right, ABT-03 bottom right (by the entrance),
//    ABT-04 bottom left. Tilt 30° down until "Adjust 3D floor" fits it.
const BUKIT_TINGGI: ShopLayout = {
  outline: [
    { x: 0, y: 0 },
    { x: 4.208, y: 0 },
    { x: 7.314, y: 5.86 },
    { x: 0, y: 5.86 },
  ],
  regions: [
    {
      id: 'counter',
      name: 'Counter',
      kind: 'Counter',
      floor: [
        { x: 1.05, y: 0 },
        { x: 1.05, y: 2.73 },
        { x: 3.95, y: 2.73 },
        { x: 5.422, y: 2.29 },
        { x: 4.208, y: 0 },
      ],
      z_min: 0,
      z_max: 2.2,
    },
    {
      id: 'purchasing',
      name: 'Purchasing',
      kind: 'Purchasing',
      floor: [
        { x: 0, y: 0 },
        { x: 1.05, y: 0 },
        { x: 1.05, y: 2.73 },
        { x: 3.95, y: 2.73 },
        { x: 5.422, y: 2.29 },
        { x: 7.314, y: 5.86 },
        { x: 0, y: 5.86 },
      ],
      z_min: 0,
      z_max: 2.2,
    },
    {
      id: 'outside',
      name: 'Outside Shop',
      kind: 'Outside Shop',
      floor: [
        { x: 3.678, y: -1 },
        { x: 4.208, y: 0 },
        { x: 7.314, y: 5.86 },
        { x: 7.844, y: 6.86 },
        { x: 11, y: 6.86 },
        { x: 11, y: -1 },
      ],
      z_min: 0,
      z_max: 2.5,
    },
  ],
  cameras: {
    'ABT-01': { x: 0.33, y: 5.59, yaw: 115, tilt: 30 },
    'ABT-02': { x: 6.93, y: 5.61, yaw: 214, tilt: 30 },
    'ABT-03': { x: 3.91, y: 0.29, yaw: 316, tilt: 30 },
    'ABT-04': { x: 0.31, y: 0.26, yaw: 38, tilt: 30 },
  },
}

// The drawing for a branch (by name), or null
export function layoutFor(branchName: string): ShopLayout | null {
  return /bukit\s*tinggi/i.test(branchName) ? BUKIT_TINGGI : null
}
