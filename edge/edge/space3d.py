"""3D floor space of one camera, and the shop areas (regions) drawn on it.

The floor is made AUTOMATICALLY: every camera hangs at the same, fixed height
(CAMERA_HEIGHT, 3.25 m). From that height, the camera's tilt (worked out on
the Camera details page from people walking past), the lens width and the lens
curve, the box knows the whole floor. The Tapo lens is wide and round, so a
flat floor looks bent at the sides of the picture; the lens curve (k1) undoes
that before anything is measured.

Saved by the website (Camera details page → "Shop areas (3D)") in camera.floor_areas:

    {"version": 3,
     "calibration": {
        "mode": "auto",                                     # floor made automatically
        "aspect": 1.7778,                                  # picture width / height
        "camera_height": 3.25,                              # metres, fixed
        "tilt": 35, "hfov": 95,                             # degrees: tilt down, lens width
        "k1": -0.2, "focal": 0.83,                          # lens curve, focal length (picture units)
        "placed": false, "place": {"x": 0, "y": 0, "yaw": 0},  # camera position on the shop plan
        "image_points": [...], "floor_points": [...],       # 4 floor points (for the grid)
        "img_to_floor": [9 numbers],                        # picture (lens curve removed) → floor
        "projection":   [12 numbers]},                      # floor 3D (X, Y, Z metres) → picture (before lens curve)
     "regions": [
        {"id": "r1", "name": "Counter", "kind": "Counter",
         "image": [{"x": .., "y": ..}, ...],                # outline on the floor, in the picture (0-1)
         "floor": [{"x": .., "y": ..}, ...] | null,          # the same outline in metres (when calibrated)
         "z_min": 0.0, "z_max": 2.2}],                      # height range of the area (metres)
     "obstacles": [{"id": "o1", "label": "table",            # things that hide people's feet (Floor map)
                    "b": [x1, y1, x2, y2]}],                 # picture box (0-1)
     "inside_only": false}                                  # true: the whole picture is inside the shop

kind is one of "Counter", "Purchasing" (any display / Point of Purchase area,
the name is free text) or "Traffic" (the walkway outside the shop). It is what
the box writes to cctv_event.track_region. Anywhere not inside a drawn area is
"Out of Range" (outside the shop), except on an "inside_only" camera (e.g. a
camera that only sees the inside of the shop, like ABT-03): there it is
"Purchasing", and the camera has no Traffic / Out of Range.

When the cameras are placed on one shop plan ("placed": true, position X / Y
and facing direction set on the Camera page), they share the SAME floor
coordinates, so a person seen by two cameras at once lands on the same floor
spot: that is how the box knows it is one person, not two. Without a shared
plan, each camera has its own floor (centred under the camera) and people are
matched across cameras by the look of their clothes instead.

Picture coordinates: x, y are 0-1 fractions of the picture. The homography and
projection work in "square" picture units: u = x * aspect, v = y.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

import numpy as np

Point = tuple[float, float]

REGION_KINDS = ("Traffic", "Purchasing", "Counter")
INSIDE_KINDS = ("Purchasing", "Counter")  # areas inside the shop (direction In)
TRAFFIC = "Traffic"  # walkway outside the shop (direction Passed By)
OUT_OF_RANGE = "Out of Range"  # not in any drawn area
OLD_KINDS = {"Outside Shop": TRAFFIC}  # areas saved before Traffic replaced Outside Shop
MIN_HEIGHT, MAX_HEIGHT = 0.6, 2.3  # metres: a measured body height outside this is not trusted

# Automatic floor (same values as the website, src/space3d.ts)
CAMERA_HEIGHT = float(os.getenv("CAMERA_HEIGHT", "3.25"))  # metres, all cameras
AUTO_TILT = 25.0  # degrees down from level, until the Camera page works it out
# Tapo C230 lens (spec 75° across, 41° up-down, 88° corner to corner) =
# straight-lens width 63.6° at the centre + lens curve -0.52 (same angles within 0.2°)
AUTO_HFOV = 63.6  # degrees, lens width at the centre
AUTO_K1 = -0.52  # lens curve (negative = round / barrel, like the Tapo lens)


def auto_matrices(aspect: float, height: float, tilt: float, hfov: float,
                  place: tuple[float, float, float] = (0.0, 0.0, 0.0)) -> tuple[np.ndarray, np.ndarray, float]:
    """img_to_floor (3x3), projection (3x4) and focal length of a camera at
    `height` metres, tilted `tilt` degrees down, facing `yaw` degrees (0 = +Y),
    standing over (x, y) on the floor. Same maths as autoCalibration() on the website."""
    f = (aspect / 2) / math.tan(math.radians(hfov) / 2)
    K = np.array([[f, 0, aspect / 2], [0, f, 0.5], [0, 0, 1.0]])
    th, yaw = math.radians(tilt), math.radians(place[2])
    facing = np.array([math.sin(yaw), math.cos(yaw), 0.0])
    right = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
    fwd = math.cos(th) * facing + np.array([0.0, 0.0, -math.sin(th)])
    down = np.cross(fwd, right)
    R = np.vstack([right, down, fwd])
    C = np.array([place[0], place[1], height])
    P = K @ np.hstack([R, (-R @ C)[:, None]])
    H = P[:, [0, 1, 3]]
    return np.linalg.inv(H), P, f


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
    kind: str  # "Counter" | "Purchasing" | "Traffic"
    image: tuple[Point, ...]  # picture outline (0-1)
    floor: tuple[Point, ...] | None  # floor outline (metres)
    z_min: float = 0.0
    z_max: float = 2.5


@dataclass(frozen=True)
class Obstacle:
    """Something standing on the floor that hides people's legs / feet (display
    table, counter, suitcase stand, mannequin), saved from the Floor map on the
    Camera details page (camera.floor_areas.obstacles). box = picture box (0-1)."""

    id: str
    label: str
    box: tuple[float, float, float, float]  # x1, y1, x2, y2 (0-1)


@dataclass(frozen=True)
class Space:
    aspect: float
    img_to_floor: np.ndarray | None  # 3x3
    projection: np.ndarray | None  # 3x4
    regions: tuple[Region, ...]
    k1: float = 0.0  # lens curve
    focal: float = 0.0  # focal length in picture units (needed for the lens curve)
    shared: bool = False  # floor coordinates shared with the other cameras (placed on one shop plan)
    inside_only: bool = False  # the whole picture is inside the shop (no Traffic / Out of Range)
    obstacles: tuple[Obstacle, ...] = ()  # things on the floor that hide people's feet

    def behind_obstacle(self, box: tuple[float, float, float, float]) -> Obstacle | None:
        """The obstacle whose picture box covers the BOTTOM of this person box
        (x1, y1, x2, y2 as 0-1): their feet are hidden behind it."""
        x1, _, x2, y2 = box
        w = max(x2 - x1, 1e-6)
        for o in self.obstacles:
            ox1, oy1, ox2, oy2 = o.box
            overlap = min(x2, ox2) - max(x1, ox1)
            # the box ends on the upper part of the obstacle (its top edge hides the legs);
            # feet lower than that are in front of it, on the floor
            if overlap >= 0.3 * w and oy1 - 0.02 <= y2 <= oy1 + 0.6 * (oy2 - oy1):
                return o
        return None

    @property
    def calibrated(self) -> bool:
        return self.img_to_floor is not None and self.projection is not None

    @staticmethod
    def automatic(aspect: float = 16 / 9, regions: tuple[Region, ...] = (), inside_only: bool = False) -> "Space":
        """The floor before the Camera page saved one: fixed height, usual tilt and lens."""
        h_inv, P, f = auto_matrices(aspect, CAMERA_HEIGHT, AUTO_TILT, AUTO_HFOV)
        return Space(aspect, h_inv, P, regions, AUTO_K1, f, False, inside_only)

    def kind_at(self, region: "Region | None") -> str:
        """track_region of a spot: the area's kind, or (no area there) Out of
        Range — Purchasing on an inside-only camera."""
        if region is not None:
            return region.kind
        return "Purchasing" if self.inside_only else OUT_OF_RANGE

    @property
    def counting(self) -> bool:
        """In / Passed By / Out can be worked out: areas drawn, or inside-only camera."""
        return self.inside_only or bool(self.regions)

    # ---------- lens curve (division model, same as the website) ----------
    def _straighten(self, p: Point) -> Point:
        """Picture point → where it would be with a straight (not round) lens:
        straight = picture / (1 + k1·r²), k1 < 0 for a round lens."""
        if not self.k1 or not self.focal:
            return p
        cx, f = self.aspect / 2, self.focal
        nx, ny = (p[0] * self.aspect - cx) / f, (p[1] - 0.5) / f
        s = max(1 + self.k1 * (nx * nx + ny * ny), 0.05)
        return (cx + f * nx / s) / self.aspect, 0.5 + f * ny / s

    def _bend(self, x: float, y: float) -> Point:
        """Straight-lens picture point → where the round Tapo lens shows it
        (never folds back: far-away floor bends towards the lens rim)."""
        if not self.k1 or not self.focal:
            return x, y
        cx, f = self.aspect / 2, self.focal
        ux, uy = (x * self.aspect - cx) / f, (y - 0.5) / f
        ru = math.hypot(ux, uy)
        if ru < 1e-9:
            return x, y
        rd = (1 - math.sqrt(1 - 4 * self.k1 * ru * ru)) / (2 * self.k1 * ru)
        s = rd / ru
        return (cx + f * ux * s) / self.aspect, 0.5 + f * uy * s

    @staticmethod
    def from_json(value: dict | None) -> "Space | None":
        if not isinstance(value, dict) or value.get("version") != 3:
            return None  # empty, or saved in an older layout: the automatic floor is used
        pt = lambda d: (float(d["x"]), float(d["y"]))  # noqa: E731
        cal = value.get("calibration") or {}
        aspect = float(cal.get("aspect") or 16 / 9)
        h_inv = proj = None
        try:
            k1, focal = float(cal.get("k1") or 0.0), float(cal.get("focal") or 0.0)
        except (TypeError, ValueError):
            k1 = focal = 0.0
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
                kind = OLD_KINDS.get(r.get("kind"), r.get("kind"))
                kind = kind if kind in REGION_KINDS else "Purchasing"
                if len(image) < 3 and floor is None:
                    continue
                regions.append(Region(
                    id=str(r.get("id") or f"r{i + 1}"), name=str(r.get("name") or kind), kind=kind,
                    image=image, floor=floor,
                    z_min=float(r.get("z_min") or 0.0), z_max=float(r.get("z_max") or 2.5),
                ))
            except (TypeError, KeyError, ValueError):
                continue
        inside_only = value.get("inside_only") is True
        obstacles: list[Obstacle] = []
        for i, o in enumerate(value.get("obstacles") or []):
            try:
                b = [float(v) for v in o["b"]]
                if len(b) == 4 and b[2] > b[0] and b[3] > b[1]:
                    obstacles.append(Obstacle(str(o.get("id") or f"o{i + 1}"), str(o.get("label") or "obstacle"),
                                              (b[0], b[1], b[2], b[3])))
            except (TypeError, KeyError, ValueError):
                continue
        if h_inv is None:  # areas saved but no floor yet: automatic floor
            s = Space.automatic(aspect, tuple(regions), inside_only)
            return Space(s.aspect, s.img_to_floor, s.projection, s.regions, s.k1, s.focal, False, inside_only,
                         tuple(obstacles))
        return Space(aspect, h_inv, proj, tuple(regions), k1, focal, bool(cal.get("placed")), inside_only,
                     tuple(obstacles))

    # ---------- picture ↔ floor ----------
    def floor_of(self, p: Point) -> Point | None:
        """Floor spot (metres) under a picture point that touches the floor (the feet)."""
        if self.img_to_floor is None:
            return None
        p = self._straighten(p)
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
        v = self._straighten(head)[1]
        den = v * P[2, 2] - P[1, 2]
        if abs(den) < 1e-12:
            return None
        z = float((P[1] @ base - v * (P[2] @ base)) / den)
        return z if MIN_HEIGHT <= z <= MAX_HEIGHT else None

    def floor_from_head(self, head: Point, height: float) -> Point | None:
        """Floor spot (metres) of a person whose FEET are hidden (behind a table,
        a display or another shopper): the top of the head is `height` metres
        above the floor, so the spot comes from the head instead of the feet.
        Stops the floor position jumping when the legs disappear."""
        if self.projection is None or not (MIN_HEIGHT <= height <= MAX_HEIGHT):
            return None
        P = self.projection
        M = np.column_stack([P[:, 0], P[:, 1], P[:, 2] * height + P[:, 3]])
        p = self._straighten(head)
        try:
            X, Y, W = np.linalg.solve(M, np.array([p[0] * self.aspect, p[1], 1.0]))
        except np.linalg.LinAlgError:
            return None
        if abs(W) < 1e-9:
            return None
        return float(X / W), float(Y / W)

    def to_picture(self, X: float, Y: float, Z: float) -> Point | None:
        if self.projection is None:
            return None
        u, v, w = self.projection @ np.array([X, Y, Z, 1.0])
        if w <= 1e-9:
            return None
        return self._bend(float(u / w / self.aspect), float(v / w))

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
