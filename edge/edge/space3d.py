"""3D floor space of one camera, and the shop areas (regions) drawn on it.

Saved by the website (Camera details page → "Areas (3D)") in camera.floor_areas:

    {"version": 3,
     "calibration": {
        "aspect": 1.7778,                                  # picture width / height
        "image_points": [{"x": 0.12, "y": 0.91}, ... 4],    # 4 floor marks in the picture (0-1)
        "floor_points": [{"x": 0.0, "y": 0.0}, ... 4],      # the same 4 marks on the SHOP floor (metres)
        "img_to_floor": [9 numbers],                        # picture → floor (homography)
        "projection":   [12 numbers],                       # floor 3D (X, Y, Z metres) → picture
        "camera_height": 2.7},                              # metres, worked out from the 4 marks
     "regions": [
        {"id": "r1", "name": "Counter", "kind": "Counter",
         "image": [{"x": .., "y": ..}, ...],                # outline on the floor, in the picture (0-1)
         "floor": [{"x": .., "y": ..}, ...] | null,          # the same outline in metres (when calibrated)
         "z_min": 0.0, "z_max": 2.2}]}                      # height range of the area (metres)

kind is one of "Counter", "Purchasing" (any display / Point of Purchase area,
the name is free text) or "Outside Shop". It is what the box writes to
cctv_event.track_region.

Every camera of a shop uses the SAME floor coordinates (metres from one corner
of the shop), so a person seen by two cameras at once lands on the same floor
spot: that is how the box knows it is one person, not two.

Picture coordinates: x, y are 0-1 fractions of the picture. The homography and
projection work in "square" picture units: u = x * aspect, v = y.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

Point = tuple[float, float]

REGION_KINDS = ("Outside Shop", "Purchasing", "Counter")
MIN_HEIGHT, MAX_HEIGHT = 0.6, 2.3  # metres: a measured body height outside this is not trusted


def inside(poly: list[Point], p: Point) -> bool:
    """Point-in-polygon (even-odd rule)."""
    x, y = p
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    kind: str  # "Counter" | "Purchasing" | "Outside Shop"
    image: tuple[Point, ...]  # picture outline (0-1)
    floor: tuple[Point, ...] | None  # floor outline (metres)
    z_min: float = 0.0
    z_max: float = 2.5


@dataclass(frozen=True)
class Space:
    aspect: float
    img_to_floor: np.ndarray | None  # 3x3
    projection: np.ndarray | None  # 3x4
    regions: tuple[Region, ...]

    @property
    def calibrated(self) -> bool:
        return self.img_to_floor is not None and self.projection is not None

    @staticmethod
    def from_json(value: dict | None) -> "Space | None":
        if not isinstance(value, dict) or value.get("version") != 3:
            return None  # empty, or saved in an older layout: set the areas again on the Camera page
        pt = lambda d: (float(d["x"]), float(d["y"]))  # noqa: E731
        cal = value.get("calibration") or {}
        aspect = float(cal.get("aspect") or 16 / 9)
        h_inv = proj = None
        try:
            if len(cal.get("img_to_floor") or []) == 9 and len(cal.get("projection") or []) == 12:
                h_inv = np.array(cal["img_to_floor"], dtype=float).reshape(3, 3)
                proj = np.array(cal["projection"], dtype=float).reshape(3, 4)
                if not (np.isfinite(h_inv).all() and np.isfinite(proj).all()):
                    h_inv = proj = None
        except (TypeError, ValueError):
            h_inv = proj = None
        regions: list[Region] = []
        for i, r in enumerate(value.get("regions") or []):
            try:
                image = tuple(pt(p) for p in r.get("image") or [])
                floor = tuple(pt(p) for p in r["floor"]) if r.get("floor") and len(r["floor"]) >= 3 else None
                kind = r.get("kind") if r.get("kind") in REGION_KINDS else "Purchasing"
                if len(image) < 3 and floor is None:
                    continue
                regions.append(Region(
                    id=str(r.get("id") or f"r{i + 1}"), name=str(r.get("name") or kind), kind=kind,
                    image=image, floor=floor,
                    z_min=float(r.get("z_min") or 0.0), z_max=float(r.get("z_max") or 2.5),
                ))
            except (TypeError, KeyError, ValueError):
                continue
        if h_inv is None and not regions:
            return None
        return Space(aspect, h_inv, proj, tuple(regions))

    # ---------- picture ↔ floor ----------
    def floor_of(self, p: Point) -> Point | None:
        """Floor spot (metres) under a picture point that touches the floor (the feet)."""
        if self.img_to_floor is None:
            return None
        X, Y, W = self.img_to_floor @ np.array([p[0] * self.aspect, p[1], 1.0])
        if abs(W) < 1e-9:
            return None
        return float(X / W), float(Y / W)

    def height_of(self, floor: Point, head: Point) -> float | None:
        """Body height (metres): the Z above the floor spot that lands on the top of the head."""
        if self.projection is None:
            return None
        P = self.projection
        base = np.array([floor[0], floor[1], 0.0, 1.0])
        v = head[1]
        den = v * P[2, 2] - P[1, 2]
        if abs(den) < 1e-12:
            return None
        z = float((P[1] @ base - v * (P[2] @ base)) / den)
        return z if MIN_HEIGHT <= z <= MAX_HEIGHT else None

    def to_picture(self, X: float, Y: float, Z: float) -> Point | None:
        if self.projection is None:
            return None
        u, v, w = self.projection @ np.array([X, Y, Z, 1.0])
        if w <= 1e-9:
            return None
        return float(u / w / self.aspect), float(v / w)

    # ---------- regions ----------
    def region_at(self, foot: Point | None, floor: Point | None, height: float | None) -> Region | None:
        """First region (in the order the admin listed them) the person stands in.
        3D when the camera is calibrated: floor outline in metres, and the body
        (0 → height) must reach into the region's height range. Otherwise 2D:
        the feet point inside the outline drawn on the picture."""
        for r in self.regions:
            if r.floor is not None and floor is not None:
                if not inside(list(r.floor), floor):
                    continue
                if height is not None and (height < r.z_min or r.z_max <= 0):
                    continue
                return r
            if foot is not None and len(r.image) >= 3 and inside(list(r.image), foot):
                return r
        return None
