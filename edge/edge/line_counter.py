"""Counts people walking into the shop's "In" area of the camera picture.

The count line is drawn on the dashboard as many dots joined into one line.
The line is stretched at both ends to the picture's border, which splits the
picture into two areas. The admin labels one of them "In" (inside the shop);
the other is "Out". Saved in camera.count_line (0-1 coordinates = fraction of
the picture width / height):

    {"points":  [{"x": 0.10, "y": 0.62}, {"x": 0.45, "y": 0.55}, ...],
     "in_point": {"x": 0.50, "y": 0.90},          # where the admin clicked "In"
     "in_zone":  [{"x": ..., "y": ...}, ...]}      # the In area (polygon)

The older two-point line {"start": ..., "end": ...} still works: its In side
is the side the green arrow pointed to.

Rules (per tracked person):
  - A person's feet (both bottom corners of their box) must be completely
    inside one area for a few frames before that area counts.
  - In:  the person was seen in the Out area, then their feet are completely
         in the In area.
  - Out: only for a person already counted In, whose feet are then completely
         back in the Out area. People who were never counted In are not
         counted Out.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

Point = tuple[float, float]

STEADY_FRAMES = 3  # frames the feet must stay completely in an area before it counts


# ---------- Geometry (0-1 coordinates; the same steps as the website) ----------
def _exit_point(p: Point, d: Point) -> Point:
    """Where the ray p + s*d (s > 0) leaves the 0-1 square."""
    s_best = None
    for axis in (0, 1):
        if d[axis] > 1e-12:
            s = (1 - p[axis]) / d[axis]
        elif d[axis] < -1e-12:
            s = -p[axis] / d[axis]
        else:
            continue
        if s_best is None or s < s_best:
            s_best = s
    if s_best is None:
        return p
    return (min(max(p[0] + s_best * d[0], 0.0), 1.0), min(max(p[1] + s_best * d[1], 0.0), 1.0))


def _perimeter_pos(p: Point) -> float:
    """Position along the picture border, clockwise from the top-left corner (0-4)."""
    x, y = p
    eps = 1e-6
    if y <= eps:
        return x
    if x >= 1 - eps:
        return 1 + y
    if y >= 1 - eps:
        return 2 + (1 - x)
    return 3 + (1 - y)


_CORNERS = [(1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)]  # at border positions 1, 2, 3, 4(=0)


def _walk_border(a: Point, b: Point, clockwise: bool) -> list[Point]:
    """Picture corners passed when walking along the border from a to b."""
    ta, tb = _perimeter_pos(a), _perimeter_pos(b)
    span = (tb - ta) % 4 if clockwise else (ta - tb) % 4
    passed: list[tuple[float, Point]] = []
    for k, corner in zip((1, 2, 3, 4), _CORNERS):
        dist = (k - ta) % 4 if clockwise else (ta - k) % 4
        if 0 < dist < span:
            passed.append((dist, corner))
    passed.sort(key=lambda item: item[0])
    return [corner for _, corner in passed]


def extended_line(points: list[Point]) -> list[Point]:
    """The drawn line, stretched straight out at both ends to the picture border."""
    if len(points) < 2:
        return list(points)
    p0, p1 = points[0], points[1]
    pn, pm = points[-1], points[-2]
    start = _exit_point(p0, (p0[0] - p1[0], p0[1] - p1[1]))
    end = _exit_point(pn, (pn[0] - pm[0], pn[1] - pm[1]))
    return [start, *points, end]


def split_areas(points: list[Point]) -> tuple[list[Point], list[Point]]:
    """The two areas (polygons) the stretched line cuts the picture into."""
    path = extended_line(points)
    start, end = path[0], path[-1]
    a = path + _walk_border(end, start, clockwise=True)
    b = path + _walk_border(end, start, clockwise=False)
    return a, b


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


def in_area_for(points: list[Point], in_point: Point) -> list[Point]:
    """The area that contains the point the admin clicked as "In"."""
    a, b = split_areas(points)
    return a if inside(a, in_point) else b


@dataclass
class CountLine:
    points: list[Point]
    in_zone: list[Point]

    @staticmethod
    def from_json(value: dict | None) -> "CountLine | None":
        if not isinstance(value, dict):
            return None
        pt = lambda d: (float(d["x"]), float(d["y"]))  # noqa: E731
        try:
            if "points" in value:
                points = [pt(p) for p in value["points"]]
                if len(points) < 2:
                    return None
                if value.get("in_zone") and len(value["in_zone"]) >= 3:
                    zone = [pt(p) for p in value["in_zone"]]
                elif value.get("in_point"):
                    zone = in_area_for(points, pt(value["in_point"]))
                else:
                    return None  # line drawn but no In area labelled yet
                return CountLine(points, zone)
            # Older two-point line: In = the side the green arrow points to
            s, e = pt(value["start"]), pt(value["end"])
        except (TypeError, KeyError, ValueError):
            return None
        if s == e:
            return None
        mid = ((s[0] + e[0]) / 2, (s[1] + e[1]) / 2)
        dx, dy = e[0] - s[0], e[1] - s[1]
        n = max((dx * dx + dy * dy) ** 0.5, 1e-9)
        in_point = (min(max(mid[0] + dy / n * 0.05, 0), 1), min(max(mid[1] - dx / n * 0.05, 0), 1))
        return CountLine([s, e], in_area_for([s, e], in_point))

    def area(self, p: Point) -> str:
        """"in" or "out" for one point."""
        return "in" if inside(self.in_zone, p) else "out"

    def area_of(self, feet: list[Point]) -> str | None:
        """"in" / "out" when ALL the feet points are in that area, None while on the line."""
        areas = {self.area(p) for p in feet}
        return areas.pop() if len(areas) == 1 else None


# ---------- Counter ----------
@dataclass
class _Track:
    last_seen: float
    area: str | None = None  # area the feet were last steadily (completely) in
    candidate: str | None = None
    streak: int = 0
    seen_out: bool = False  # steadily in the Out area at some point
    counted_in: bool = False  # counted In, and not counted Out since


@dataclass
class Crossing:
    track_id: int
    direction: str  # "In" | "Out"


@dataclass
class LineCounter:
    """Feed it each person's feet points every frame; it returns the crossings."""

    line: CountLine | None
    steady_frames: int = STEADY_FRAMES
    forget_after: float = 10.0
    _tracks: dict[int, _Track] = field(default_factory=dict)

    def set_line(self, line: CountLine | None) -> None:
        if line != self.line:
            self.line = line
            self._tracks.clear()

    def area_of(self, track_id: int) -> str | None:
        t = self._tracks.get(track_id)
        return t.area if t else None

    def update(self, feet: dict[int, list[Point]], now: float | None = None) -> list[Crossing]:
        now = time.monotonic() if now is None else now
        crossings: list[Crossing] = []
        if self.line is None:
            return crossings

        for track_id, pts in feet.items():
            t = self._tracks.setdefault(track_id, _Track(now))
            t.last_seen = now
            area = self.line.area_of(pts) if pts else None
            if area is None:  # feet on the line, or not fully visible: wait
                t.candidate, t.streak = None, 0
                continue
            if area == t.area:
                t.candidate, t.streak = None, 0
                continue
            if area != t.candidate:
                t.candidate, t.streak = area, 0
            t.streak += 1
            if t.streak < self.steady_frames:
                continue
            # Feet completely in a new area for long enough
            t.area, t.candidate, t.streak = area, None, 0
            if area == "out":
                if t.counted_in:
                    crossings.append(Crossing(track_id, "Out"))
                    t.counted_in = False
                t.seen_out = True
            elif area == "in" and t.seen_out and not t.counted_in:
                crossings.append(Crossing(track_id, "In"))
                t.counted_in = True

        for track_id in [k for k, v in self._tracks.items() if now - v.last_seen > self.forget_after]:
            del self._tracks[track_id]
        return crossings
