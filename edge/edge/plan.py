"""Shop areas drawn ONCE on the shop floor plan (top view, metres), shared by all
cameras of the branch: branch.plan_areas (supabase/plan_areas.sql), edited on the
Camera details page → Shop Floor Map → "Edit areas on plan".

Why: areas drawn on each camera's PICTURE are seen in perspective. A line on the
floor drawn on a tilted, round-lens picture lands somewhere else on the real floor
(the "optical illusion"), and the 4 cameras each drew their own, so one person in
the overlap of two cameras could stand in "Counter" on ABT-02 and in "Purchasing"
on ABT-04 at the same moment. On the plan there is ONE outline per area: every
camera placed on the plan turns the person's feet into a floor spot (metres) and
asks the SAME outlines where that spot is.

    {"version": 1,
     "margin": 0.25,                       # metres: a spot this close to an area's line counts as in it
     "shop":  [{"x": 0, "y": 0}, ...],      # the shop's walls (inside = shop floor)
     "areas": [{"id": "a1", "name": "Counter", "kind": "Counter",
                "pts": [{"x": .., "y": ..}, ...]}, ...]}

kind: "Purchasing" / "Counter" (inside the shop, In), "Traffic" (walkway outside
the shop, Passed By), "Staff" (staff-only side of the counter: recorded as
Counter; someone who stays there is a staff).

Where is a floor spot?  (locate)
  1. Inside an area's outline: that area. Areas inside other areas win (a Staff
     zone drawn inside Counter), then the smaller area.
  2. Within `margin` of an area's line (touching the line counts): the nearest such area.
  3. Inside the shop walls (+ margin) but in no area: Purchasing (a gap between two
     areas is still the shop floor; it never makes an Out).
  4. Anywhere else: Out of Range.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

Point = tuple[float, float]

PLAN_KINDS = ("Purchasing", "Counter", "Traffic", "Staff")
STAFF = "Staff"
INSIDE = ("Purchasing", "Counter", STAFF)
DEFAULT_MARGIN = 0.25  # metres


def _inside(poly: tuple[Point, ...], p: Point) -> bool:
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


def _edge_distance(poly: tuple[Point, ...], p: Point) -> float:
    """Shortest distance from p to the outline (metres)."""
    best = math.inf
    px, py = p
    for i in range(len(poly)):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % len(poly)]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L <= 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best


def _area(poly: tuple[Point, ...]) -> float:
    return abs(sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                   for i in range(len(poly)))) / 2


def signed_distance(poly: tuple[Point, ...], p: Point) -> float:
    """< 0 inside the outline, > 0 outside (metres)."""
    d = _edge_distance(poly, p)
    return -d if _inside(poly, p) else d


@dataclass(frozen=True)
class PlanArea:
    id: str
    name: str
    kind: str  # Purchasing / Counter / Traffic / Staff
    pts: tuple[Point, ...]
    size: float  # m²

    @property
    def track_region(self) -> str:
        """What cctv_event.track_region says for this area."""
        return "Counter" if self.kind == STAFF else self.kind


@dataclass(frozen=True)
class Spot:
    """Where a floor spot is on the plan."""

    area: PlanArea | None
    kind: str  # Purchasing / Counter / Traffic / Out of Range (track_region)
    staff_zone: bool  # in the staff-only side of the counter
    exact: bool  # inside the outline (False: only touching its line, within the margin)


class ShopPlan:
    def __init__(self, areas: list[PlanArea], shop: tuple[Point, ...] | None, margin: float):
        self.areas = areas
        self.shop = shop if shop and len(shop) >= 3 else None
        self.margin = margin
        # nested areas first (a Staff zone inside Counter), then small before large
        self._order = sorted(areas, key=lambda a: (a.kind != STAFF, a.size))

    @staticmethod
    def from_json(value: object) -> "ShopPlan | None":
        if not isinstance(value, dict):
            return None
        pt = lambda d: (float(d["x"]), float(d["y"]))  # noqa: E731
        areas: list[PlanArea] = []
        for i, a in enumerate(value.get("areas") or []):
            try:
                pts = tuple(pt(p) for p in a.get("pts") or [])
            except (TypeError, KeyError, ValueError):
                continue
            kind = a.get("kind")
            if len(pts) < 3 or kind not in PLAN_KINDS:
                continue
            areas.append(PlanArea(str(a.get("id") or f"a{i + 1}"), str(a.get("name") or kind), kind, pts, _area(pts)))
        if not areas:
            return None
        try:
            shop = tuple(pt(p) for p in value.get("shop") or []) or None
        except (TypeError, KeyError, ValueError):
            shop = None
        try:
            margin = float(value.get("margin", DEFAULT_MARGIN))
        except (TypeError, ValueError):
            margin = DEFAULT_MARGIN
        return ShopPlan(areas, shop, max(0.0, min(margin, 1.5)))

    def _in_shop(self, p: Point, extra: float = 0.0) -> bool:
        if self.shop is not None:
            return signed_distance(self.shop, p) <= extra
        # no walls saved: the inside areas together are the shop
        return any(signed_distance(a.pts, p) <= extra for a in self.areas if a.kind in INSIDE)

    def locate(self, p: Point) -> Spot:
        for a in self._order:  # 1. inside an outline
            if _inside(a.pts, p):
                return Spot(a, a.track_region, a.kind == STAFF, True)
        near = [(d, a) for a in self.areas if (d := _edge_distance(a.pts, p)) <= self.margin]
        if near:  # 2. touching an area's line
            d, a = min(near, key=lambda x: (x[0], x[1].kind != STAFF))
            return Spot(a, a.track_region, a.kind == STAFF, False)
        if self._in_shop(p, self.margin):  # 3. a gap on the shop floor
            return Spot(None, "Purchasing", False, False)
        return Spot(None, "Out of Range", False, False)

    def watched(self, p: Point, extra: float) -> bool:
        """Is this floor spot the shop, the walkway, or within `extra` metres of them?
        People further away (other shops, the far side of the mall, the escalator)
        are not followed."""
        return self._in_shop(p, extra) or any(signed_distance(a.pts, p) <= extra for a in self.areas)
