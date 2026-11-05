"""3D floor space of one camera, and the shop areas (regions) drawn on it.

Each camera has its OWN floor, saved by the website (Camera details page →
Shop Areas → "Adjust 3D floor") in camera.floor_areas. There is no shared shop
plan any more: areas are drawn straight on each camera's picture, so where a
person stands never depends on a guessed camera height or lens.

The floor is a MESH of polylines the admin drags onto the real floor:
  - X lines (red): floor lines along X, one per Y metre mark (a row of dots);
  - Y lines (green): floor lines along Y, one per X metre mark (a column of dots);
    each dot = where the floor point (X, Y) is in the picture. Because every dot
    is placed by hand on the floor tiles, the round Tapo lens and a wrong height
    or tilt no longer matter: picture → floor goes through the dragged cells.
  - Z poles (blue): a dot on the floor and a dot 1 m and 2 m above it, placed
    on something of known height. They tell how tall 1 m looks at each spot,
    which is what turns the TOP OF THE HEAD into a floor spot when the feet are
    hidden behind the counter or a display table.
Without a mesh (never adjusted) the automatic floor is used (camera height
CAMERA_HEIGHT, tilt, lens curve), as before.

    {"version": 3,
     "calibration": {
        "mode": "auto",                                     # automatic floor (also the mesh's first guess)
        "aspect": 1.7778,                                  # picture width / height
        "camera_height": 3.25, "tilt": 35, "hfov": 95,      # metres, degrees
        "k1": -0.2, "focal": 0.83,                          # lens curve, focal length (picture units)
        "image_points": [...], "floor_points": [...],
        "img_to_floor": [9 numbers], "projection": [12 numbers],
        "mesh": {                                          # optional: the dragged floor (wins when present)
           "xs": [-2, -1, 0, 1, 2],                         # metres of the Y lines
           "ys": [1, 2, 3, 4],                             # metres of the X lines
           "nodes": [[{"x": .., "y": ..}, ...], ...],       # nodes[i][j] = picture of (xs[j], ys[i]), 0-1
           "poles": [{"base": {"x", "y"}, "marks": [{"x", "y"}, {"x", "y"}]}]}},  # 1 m, 2 m above base
     "regions": [
        {"id": "r1", "name": "Counter", "kind": "Counter",
         "image": [{"x": .., "y": ..}, ...],                # outline of the floor you can SEE (0-1)
         "hidden": [[{"x": .., "y": ..}, ...], ...],         # blind spots of this area (dotted on the website):
                                                            # floor hidden behind the counter / tables where
                                                            # people still walk or stand
         "floor": null, "z_min": 0.0, "z_max": 2.2}],
     "obstacles": [...],                                    # older saved obstacles (still honoured)
     "inside_only": false}

kind is one of "Counter", "Purchasing" (inside the shop: In) or "Traffic"
(the walkway outside the shop: Passed By). It is what the box writes to
cctv_event.track_region. Anywhere not inside a drawn area is "Out of Range",
except on an "inside_only" camera, where it is "Purchasing".

Blind spots: a person whose box ENDS inside a blind spot has their feet hidden
(the box bottom is the edge of the counter / table, not the floor), so their
floor spot is worked out from the top of the head and the Z poles. That spot
then counts for the area the blind spot belongs to.

Picture coordinates: x, y are 0-1 fractions of the picture. Geometry is done in
"square" picture units: u = x * aspect, v = y.
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


def _edge_distance(poly: tuple[Point, ...] | list[Point], p: Point) -> float:
    """Shortest distance from p to the outline."""
    best = math.inf
    px, py = p
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L <= 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best


def signed_distance(poly: tuple[Point, ...] | list[Point], p: Point) -> float:
    """< 0 inside the outline, > 0 outside."""
    d = _edge_distance(poly, p)
    return -d if inside(list(poly), p) else d


class FloorMesh:
    """The floor dragged by hand on the picture (see the module docstring).
    Same maths as the website (src/space3d.ts: meshForward / meshInverse / meshUp)."""

    def __init__(self, aspect: float, xs: list[float], ys: list[float], nodes: list[list[Point]],
                 poles: list[tuple[Point, list[Point]]], k1: float = 0.0, focal: float = 0.0):
        self.aspect = aspect
        # lens curve of the calibration: the floor needs none (the dots follow the bent floor), but
        # upright things are straight only with it removed, so the Z model works without it
        self.k1, self.focal = (k1, focal) if k1 and focal else (0.0, 0.0)
        self.xs, self.ys = xs, ys
        a = aspect
        # square picture units
        self.n = [[(x * a, y) for x, y in row] for row in nodes]
        # Smooth floor (one plane seen through a straight lens) fitted to ALL the dots: only used
        # for how big 1 m looks at a spot (_scale_sq), so a dot placed a few pixels off by hand
        # does not make the Z poles' sizes jump from cell to cell
        self.smooth = self._fit_smooth()
        # Z: one vertical model for the whole picture, fitted to the poles (see _fit_vertical)
        self.poles = [((b[0] * a, b[1]), [(m[0] * a, m[1]) for m in marks]) for b, marks in poles if marks]
        self.vertical = self._fit_vertical()

    def _fit_smooth(self) -> np.ndarray | None:
        """Homography floor (X, Y) → picture with the lens curve removed (square units),
        least squares over every dot of the mesh."""
        A: list[list[float]] = []
        rhs: list[float] = []
        for i, Y in enumerate(self.ys):
            for j, X in enumerate(self.xs):
                u, v = self._st(self.n[i][j])
                A.append([X, Y, 1, 0, 0, 0, -u * X, -u * Y])
                rhs.append(u)
                A.append([0, 0, 0, X, Y, 1, -v * X, -v * Y])
                rhs.append(v)
        if len(A) < 8:
            return None
        try:
            h, *_ = np.linalg.lstsq(np.array(A, dtype=float), np.array(rhs, dtype=float), rcond=None)
        except np.linalg.LinAlgError:
            return None
        H = np.append(h, 1.0).reshape(3, 3)
        return H if np.isfinite(H).all() else None

    def _smooth_forward(self, X: float, Y: float) -> Point:
        """Floor → picture without the lens curve, on the smooth floor (falls back to the mesh)."""
        if self.smooth is None:
            return self._st(self._forward_sq(X, Y))
        u, v, w = self.smooth @ np.array([X, Y, 1.0])
        if abs(w) < 1e-12:
            return self._st(self._forward_sq(X, Y))
        return float(u / w), float(v / w)

    # ---------- lens curve, in square units (same as Space._straighten / _bend) ----------
    def _st(self, q: Point) -> Point:
        if not self.k1:
            return q
        cx, f = self.aspect / 2, self.focal
        nx, ny = (q[0] - cx) / f, (q[1] - 0.5) / f
        s = max(1 + self.k1 * (nx * nx + ny * ny), 0.05)
        return cx + f * nx / s, 0.5 + f * ny / s

    def _bd(self, q: Point) -> Point:
        if not self.k1:
            return q
        cx, f = self.aspect / 2, self.focal
        ux, uy = (q[0] - cx) / f, (q[1] - 0.5) / f
        ru = math.hypot(ux, uy)
        if ru < 1e-9:
            return q
        inner = 1 - 4 * self.k1 * ru * ru
        if inner < 0:
            return q
        rd = (1 - math.sqrt(inner)) / (2 * self.k1 * ru)
        s = rd / ru
        return cx + f * ux * s, 0.5 + f * uy * s

    @staticmethod
    def from_json(aspect: float, value: object, k1: float = 0.0, focal: float = 0.0) -> "FloorMesh | None":
        if not isinstance(value, dict):
            return None
        try:
            xs = [float(v) for v in value.get("xs") or []]
            ys = [float(v) for v in value.get("ys") or []]
            nodes = [[(float(p["x"]), float(p["y"])) for p in row] for row in value.get("nodes") or []]
            poles = []
            for p in value.get("poles") or []:
                base = (float(p["base"]["x"]), float(p["base"]["y"]))
                marks = [(float(m["x"]), float(m["y"])) for m in p.get("marks") or []]
                if marks:
                    poles.append((base, marks))
        except (TypeError, KeyError, ValueError):
            return None
        ok = (len(xs) >= 2 and len(ys) >= 2 and len(nodes) == len(ys) and all(len(r) == len(xs) for r in nodes)
              and all(b > a for a, b in zip(xs, xs[1:])) and all(b > a for a, b in zip(ys, ys[1:]))
              and all(math.isfinite(v) for r in nodes for p in r for v in p))
        if not ok:
            return None
        m = FloorMesh(aspect, xs, ys, nodes, poles, k1, focal)
        return m if m.vertical is not None else None  # without a Z pole the head cannot give a floor spot

    # ---------- floor → picture ----------
    @staticmethod
    def _cell(marks: list[float], v: float) -> tuple[int, float]:
        """Cell index and position in it (0-1 inside; beyond the outer lines it goes on)."""
        k = 0
        while k < len(marks) - 2 and v > marks[k + 1]:
            k += 1
        return k, (v - marks[k]) / (marks[k + 1] - marks[k])

    def _bilinear(self, i: int, j: int, s: float, t: float) -> Point:
        A, B = self.n[i][j], self.n[i][j + 1]
        D, C = self.n[i + 1][j], self.n[i + 1][j + 1]
        x = (1 - s) * (1 - t) * A[0] + s * (1 - t) * B[0] + s * t * C[0] + (1 - s) * t * D[0]
        y = (1 - s) * (1 - t) * A[1] + s * (1 - t) * B[1] + s * t * C[1] + (1 - s) * t * D[1]
        return x, y

    def _forward_sq(self, X: float, Y: float) -> Point:
        j, s = self._cell(self.xs, X)
        i, t = self._cell(self.ys, Y)
        return self._bilinear(i, j, s, t)

    def forward(self, X: float, Y: float) -> Point:
        """Floor spot (metres) → picture (0-1)."""
        u, v = self._forward_sq(X, Y)
        return u / self.aspect, v

    # ---------- picture → floor ----------
    def _solve_cell(self, i: int, j: int, q: Point) -> tuple[float, float] | None:
        """(s, t) in cell (i, j) whose bilinear point is q (Newton, from the middle)."""
        s = t = 0.5
        A, B = self.n[i][j], self.n[i][j + 1]
        D, C = self.n[i + 1][j], self.n[i + 1][j + 1]
        for _ in range(20):
            px, py = self._bilinear(i, j, s, t)
            fx, fy = px - q[0], py - q[1]
            dsx = (1 - t) * (B[0] - A[0]) + t * (C[0] - D[0])
            dsy = (1 - t) * (B[1] - A[1]) + t * (C[1] - D[1])
            dtx = (1 - s) * (D[0] - A[0]) + s * (C[0] - B[0])
            dty = (1 - s) * (D[1] - A[1]) + s * (C[1] - B[1])
            det = dsx * dty - dsy * dtx
            if abs(det) < 1e-12:
                return None
            ds = (fx * dty - fy * dtx) / det
            dt = (dsx * fy - dsy * fx) / det
            s, t = s - ds, t - dt
            if abs(ds) < 1e-9 and abs(dt) < 1e-9:
                break
            if abs(s) > 50 or abs(t) > 50:
                return None
        return s, t

    def _inverse_sq(self, q: Point) -> Point | None:
        best: tuple[float, int, int, float, float] | None = None
        for i in range(len(self.ys) - 1):
            for j in range(len(self.xs) - 1):
                st = self._solve_cell(i, j, q)
                if st is None:
                    continue
                s, t = st
                out = max(0.0, -s, s - 1) + max(0.0, -t, t - 1)
                if best is None or out < best[0]:
                    best = (out, i, j, s, t)
                if out <= 1e-9:
                    break
            if best is not None and best[0] <= 1e-9:
                break
        if best is None:
            return None
        _, i, j, s, t = best
        s, t = min(max(s, -3.0), 4.0), min(max(t, -3.0), 4.0)  # far outside the mesh: not further than 3 cells
        X = self.xs[j] + s * (self.xs[j + 1] - self.xs[j])
        Y = self.ys[i] + t * (self.ys[i + 1] - self.ys[i])
        return X, Y

    def inverse(self, p: Point) -> Point | None:
        """Picture point (0-1) on the floor → floor spot (metres)."""
        return self._inverse_sq((p[0] * self.aspect, p[1]))

    # ---------- Z: how tall 1 m looks at a spot ----------
    def _scale_sq(self, f: Point | None) -> float:
        """Picture length (square units) of 1 m on the floor around floor spot f, measured
        ACROSS the picture (the floor direction that looks level in the picture). Like a
        height, that length shrinks with the distance from the camera, so "how many of
        these is 1 m up" changes little over the floor and can be blended between poles."""
        if f is None:
            return 0.0
        X, Y, e = f[0], f[1], 0.5  # over 1 m: smooth across the cells
        fw = self._smooth_forward  # lens curve removed, smooth over the whole floor
        ax, bx = fw(X - e, Y), fw(X + e, Y)
        ay, by = fw(X, Y - e), fw(X, Y + e)
        jxx, jyx = (bx[0] - ax[0]) / (2 * e), (bx[1] - ax[1]) / (2 * e)  # picture change per metre of X
        jxy, jyy = (by[0] - ay[0]) / (2 * e), (by[1] - ay[1]) / (2 * e)  # ... per metre of Y
        wx, wy = jyy, -jyx  # floor direction whose picture is level (no up / down)
        n = math.hypot(wx, wy)
        if n < 1e-12:
            return 0.0
        wx, wy = wx / n, wy / n
        return abs(jxx * wx + jxy * wy)

    # Vertical lines in a picture all point at one spot (their vanishing point), and
    # something z metres tall looks smaller the further away it stands. Away from the
    # camera, a 1 m step across the floor (_scale_sq, s) shrinks the same way, so the
    # top of a z-metre pole standing on picture point b is
    #     p(z) = (b + z·s·G) / (1 + z·s·g)
    # with G (2 numbers) and g (1 number) the same over the whole picture. Each pole
    # mark gives 2 equations that are linear in (Gx, Gy, g): one pole with its 1 m and
    # 2 m marks is enough; more poles (near, far, left, right) average out errors.
    def _fit_vertical(self) -> tuple[float, float, float] | None:
        A: list[list[float]] = []
        rhs: list[float] = []
        for b, marks in self.poles:
            s = self._scale_sq(self._inverse_sq(b))
            if s <= 1e-9:
                continue
            b = self._st(b)
            for k, p in enumerate(marks):
                p = self._st(p)
                z = float(k + 1)  # marks are 1 m, 2 m, ... above the base
                # p - b = z·s·(G - p·g)
                A.append([z * s, 0.0, -z * s * p[0]])
                rhs.append(p[0] - b[0])
                A.append([0.0, z * s, -z * s * p[1]])
                rhs.append(p[1] - b[1])
        if len(A) < 3:
            return None
        try:
            sol, *_ = np.linalg.lstsq(np.array(A), np.array(rhs), rcond=None)
        except np.linalg.LinAlgError:
            return None
        Gx, Gy, g = (float(v) for v in sol)
        if not all(math.isfinite(v) for v in (Gx, Gy, g)) or Gy >= 0:
            return None  # "up" must go up in the picture
        return Gx, Gy, g

    def _up_sq(self, base: Point, z: float) -> Point | None:
        """Square-unit picture point z metres above the floor point `base` (square units)."""
        if self.vertical is None:
            return None
        s = self._scale_sq(self._inverse_sq(base))
        if s <= 1e-9:
            return None
        Gx, Gy, g = self.vertical
        den = 1 + z * s * g
        if den <= 1e-6:
            return None
        b = self._st(base)
        return self._bd(((b[0] + z * s * Gx) / den, (b[1] + z * s * Gy) / den))

    def up(self, base: Point, z: float) -> Point | None:
        """Picture point (0-1) z metres above the floor point `base` (0-1)."""
        q = self._up_sq((base[0] * self.aspect, base[1]), z)
        return None if q is None else (q[0] / self.aspect, q[1])

    def height_at(self, foot: Point, head: Point) -> float | None:
        """Body height (metres): the z above the feet that reaches the top of the head
        (from the up-down position: hy = (by + z·s·Gy) / (1 + z·s·g))."""
        if self.vertical is None:
            return None
        b = (foot[0] * self.aspect, foot[1])
        s = self._scale_sq(self._inverse_sq(b))
        _, Gy, g = self.vertical
        b, hd = self._st(b), self._st((head[0] * self.aspect, head[1]))
        den = s * (Gy - hd[1] * g)
        if s <= 1e-9 or abs(den) < 1e-12:
            return None
        z = (hd[1] - b[1]) / den
        return z if MIN_HEIGHT <= z <= MAX_HEIGHT else None

    def foot_from_head(self, head: Point, height: float) -> Point | None:
        """Picture point (0-1) of the feet of someone `height` metres tall whose
        top of the head is at `head`: the feet are where `height` above them lands
        on the head."""
        h = (head[0] * self.aspect, head[1])
        f = h
        for _ in range(40):
            q = self._up_sq(f, height)
            if q is None:
                return None
            nf = (f[0] + (h[0] - q[0]), f[1] + (h[1] - q[1]))
            if math.dist(nf, f) < 1e-7:
                f = nf
                break
            f = nf
        return f[0] / self.aspect, f[1]


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    kind: str  # "Counter" | "Purchasing" | "Traffic"
    image: tuple[Point, ...]  # picture outline of the floor you can see (0-1)
    floor: tuple[Point, ...] | None  # floor outline (metres)
    z_min: float = 0.0
    z_max: float = 2.5
    hidden: tuple[tuple[Point, ...], ...] = ()  # blind spots of this area (picture outlines, 0-1)

    @property
    def outlines(self) -> tuple[tuple[Point, ...], ...]:
        """Every outline of the area: the floor you see and its blind spots."""
        return ((self.image,) if len(self.image) >= 3 else ()) + tuple(h for h in self.hidden if len(h) >= 3)


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
    img_to_floor: np.ndarray | None  # 3x3 (automatic floor)
    projection: np.ndarray | None  # 3x4 (automatic floor)
    regions: tuple[Region, ...]
    k1: float = 0.0  # lens curve
    focal: float = 0.0  # focal length in picture units (needed for the lens curve)
    inside_only: bool = False  # the whole picture is inside the shop (no Traffic / Out of Range)
    obstacles: tuple[Obstacle, ...] = ()  # things on the floor that hide people's feet (older saved ones)
    mesh: FloorMesh | None = None  # the floor dragged by hand (X / Y lines, Z poles): wins over the automatic floor

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

    def blind_spot(self, p: Point) -> Region | None:
        """The area whose blind spot (floor hidden behind the counter / a table) holds
        this picture point. A box ending there ends on the furniture, not on the floor."""
        for r in self.regions:
            if any(inside(list(h), p) for h in r.hidden if len(h) >= 3):
                return r
        return None

    @property
    def calibrated(self) -> bool:
        return self.mesh is not None or (self.img_to_floor is not None and self.projection is not None)

    @staticmethod
    def automatic(aspect: float = 16 / 9, regions: tuple[Region, ...] = (), inside_only: bool = False) -> "Space":
        """The floor before the Camera page saved one: fixed height, usual tilt and lens."""
        h_inv, P, f = auto_matrices(aspect, CAMERA_HEIGHT, AUTO_TILT, AUTO_HFOV)
        return Space(aspect, h_inv, P, regions, AUTO_K1, f, inside_only)

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
        mesh = FloorMesh.from_json(aspect, cal.get("mesh"), k1, focal)
        regions: list[Region] = []
        for i, r in enumerate(value.get("regions") or []):
            try:
                image = tuple(pt(p) for p in r.get("image") or [])
                hidden = tuple(tuple(pt(p) for p in h) for h in (r.get("hidden") or []) if h and len(h) >= 3)
                floor = tuple(pt(p) for p in r["floor"]) if r.get("floor") and len(r["floor"]) >= 3 else None
                kind = OLD_KINDS.get(r.get("kind"), r.get("kind"))
                kind = kind if kind in REGION_KINDS else "Purchasing"
                if len(image) < 3 and not hidden and floor is None:
                    continue
                regions.append(Region(
                    id=str(r.get("id") or f"r{i + 1}"), name=str(r.get("name") or kind), kind=kind,
                    image=image, floor=floor,
                    z_min=float(r.get("z_min") or 0.0), z_max=float(r.get("z_max") or 2.5),
                    hidden=hidden,
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
            return Space(s.aspect, s.img_to_floor, s.projection, s.regions, s.k1, s.focal, inside_only,
                         tuple(obstacles), mesh)
        return Space(aspect, h_inv, proj, tuple(regions), k1, focal, inside_only, tuple(obstacles), mesh)

    # ---------- picture ↔ floor ----------
    def floor_of(self, p: Point) -> Point | None:
        """Floor spot (metres) under a picture point that touches the floor (the feet)."""
        if self.mesh is not None:
            return self.mesh.inverse(p)
        if self.img_to_floor is None:
            return None
        p = self._straighten(p)
        X, Y, W = self.img_to_floor @ np.array([p[0] * self.aspect, p[1], 1.0])
        if abs(W) < 1e-9:
            return None
        return float(X / W), float(Y / W)

    def height_of(self, floor: Point, head: Point) -> float | None:
        """Body height (metres): the Z above the floor spot that lands on the top of the head."""
        if self.mesh is not None:
            return self.mesh.height_at(self.mesh.forward(*floor), head)
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
        if not (MIN_HEIGHT <= height <= MAX_HEIGHT):
            return None
        if self.mesh is not None:
            foot = self.mesh.foot_from_head(head, height)
            return self.mesh.inverse(foot) if foot is not None else None
        if self.projection is None:
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
        if self.mesh is not None:
            base = self.mesh.forward(X, Y)
            return base if Z == 0 else self.mesh.up(base, Z)
        if self.projection is None:
            return None
        u, v, w = self.projection @ np.array([X, Y, Z, 1.0])
        if w <= 1e-9:
            return None
        return self._bend(float(u / w / self.aspect), float(v / w))

    # ---------- regions ----------
    def region_near(self, foot: Point, feet: list[Point], margin: float) -> Region | None:
        """Area of the picture outlines for a person whose feet are at `foot`
        (between the feet) and `feet` (the two bottom corners of the box).
        Each area = the floor you can see + its blind spots (all drawn on the
        picture). Touching an area's line counts: the feet point inside an outline
        first; then a foot corner inside one; then the outline whose line is within
        `margin` (share of the picture height) of the feet point, nearest first.
        Several outlines: the one the feet point is deepest inside, never simply
        the first one listed."""
        drawn = [r for r in self.regions if r.outlines]
        if not drawn:
            return None
        scaled = lambda q: (q[0] * self.aspect, q[1])  # noqa: E731  (square units: x and y alike)
        f = scaled(foot)

        def depth(r: Region) -> float:  # < 0 inside, > 0 outside (nearest of its outlines)
            return min(signed_distance(tuple(scaled(q) for q in o), f) for o in r.outlines)

        scored = sorted(((depth(r), i, r) for i, r in enumerate(drawn)), key=lambda s: (s[0], s[1]))
        if scored[0][0] <= 0:
            return scored[0][2]
        for q in feet:
            hits = [r for r in drawn if any(inside(list(o), q) for o in r.outlines)]
            if hits:
                return min(hits, key=depth)
        d, _, r = scored[0]
        return r if d <= margin else None
