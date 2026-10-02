"""Counts people crossing the camera's count line.

The count line is two points in 0-1 coordinates (fraction of image width /
height), the same shape the dashboard saves in camera.count_line:
    {"start": {"x": 0.1, "y": 0.6}, "end": {"x": 0.9, "y": 0.6}}

Each side of the line has a sign (cross product). A person moving from the
positive side to the negative side is "In"; the other way is "Out". On the
dashboard the "In" side is the one the arrow points to.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

Point = tuple[float, float]


@dataclass
class CountLine:
    start: Point
    end: Point

    @staticmethod
    def from_json(value: dict | None) -> "CountLine | None":
        try:
            s, e = value["start"], value["end"]  # type: ignore[index]
            line = CountLine((float(s["x"]), float(s["y"])), (float(e["x"]), float(e["y"])))
        except (TypeError, KeyError, ValueError):
            return None
        if line.start == line.end:
            return None
        return line

    def side(self, p: Point) -> float:
        """> 0 on the "outside", < 0 on the "inside" (the arrow's side)."""
        (sx, sy), (ex, ey) = self.start, self.end
        return (ex - sx) * (p[1] - sy) - (ey - sy) * (p[0] - sx)

    def along(self, p: Point) -> float:
        """Where the point falls along the line: 0 = start, 1 = end."""
        (sx, sy), (ex, ey) = self.start, self.end
        dx, dy = ex - sx, ey - sy
        return ((p[0] - sx) * dx + (p[1] - sy) * dy) / (dx * dx + dy * dy)


@dataclass
class _Track:
    side: int  # +1 / -1, last side the person was clearly on
    last_seen: float


@dataclass
class Crossing:
    track_id: int
    direction: str  # "In" | "Out"


@dataclass
class LineCounter:
    """Feed it tracked points every frame; it returns the crossings.

    dead_band: points closer to the line than this (0-1 units) are ignored,
               so a person standing on the line does not count many times.
    margin:    how far past either end of the line still counts (0-1 of the
               line length), because people do not walk exactly inside it.
    """

    line: CountLine | None
    dead_band: float = 0.015
    margin: float = 0.15
    forget_after: float = 10.0
    _tracks: dict[int, _Track] = field(default_factory=dict)

    def set_line(self, line: CountLine | None) -> None:
        if line != self.line:
            self.line = line
            self._tracks.clear()

    def update(self, points: dict[int, Point], now: float | None = None) -> list[Crossing]:
        now = time.monotonic() if now is None else now
        crossings: list[Crossing] = []
        if self.line is None:
            return crossings

        length = (
            (self.line.end[0] - self.line.start[0]) ** 2 + (self.line.end[1] - self.line.start[1]) ** 2
        ) ** 0.5
        for track_id, p in points.items():
            raw = self.line.side(p) / length  # distance from the line, 0-1 units
            if abs(raw) < self.dead_band:
                if track_id in self._tracks:
                    self._tracks[track_id].last_seen = now
                continue
            side = 1 if raw > 0 else -1
            t = self.line.along(p)
            within = -self.margin <= t <= 1 + self.margin

            prev = self._tracks.get(track_id)
            if prev is None:
                self._tracks[track_id] = _Track(side, now)
                continue
            if side != prev.side and within:
                crossings.append(Crossing(track_id, "In" if prev.side > 0 else "Out"))
            prev.side = side
            prev.last_seen = now

        for track_id in [k for k, v in self._tracks.items() if now - v.last_seen > self.forget_after]:
            del self._tracks[track_id]
        return crossings
