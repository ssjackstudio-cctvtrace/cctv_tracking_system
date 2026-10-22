"""Live video for the website (Camera page and camera details page).

A small WebSocket server (standard library only, nothing extra to install).
The website opens one connection per camera screen:

    wss://<box public address>/live/<camera_id>?token=<admin token>&w=960&fps=12

and receives, many times a second, one binary message per picture:

    4 bytes   length of the JSON part (big-endian)
    JSON      {"f": frame no, "w": width, "h": height,
               "boxes": [{"track": "ABT-01-3f9a2c-7", "b": [x1, y1, x2, y2], "area": "in",
                          "visit": true, "full": true, "xyz": [X, Y, Z] (metres) or null,
                          "region": "Counter", "kind": "Counter", "g": "Female", "a": 29, "s": 71.5}],
               "counts": {"In": 3, "Out": 1}, "inside": 2 (people inside the shop now, all cameras),
               "obstacles": [{"id": "o1", "label": "table", "b": [x1, y1, x2, y2]}]}
    The picture is the one the AI looked at, so the boxes sit exactly on the
    people (camera_worker.LIVE_SYNC).
    JPEG      the picture

plus small text messages:
    {"type": "db"}                       a visit / cctv_event row for this camera
                                         was just saved → reload the records now
    {"type": "status", "live": false, "msg": "..."}   camera off / closed
    {"type": "error", "msg": "..."}      e.g. not signed in

Only signed-in admins can watch: the token is the website's admin session
token, checked against Supabase. Pictures are only sent while someone is
watching, so the box uses no mobile data for video when nobody looks.

The server listens on 127.0.0.1 only. Tailscale Funnel gives it a public
https address (see README → Live video).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
import struct
import threading
import time
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

import cv2

from .camera_worker import LIVE_SYNC, LIVE_SYNC_MAX_AGE

log = logging.getLogger("live")

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TOKEN_OK_SECONDS = 60  # sign-in checked again with Supabase at least this often (sessions end after 10 min idle)
UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


def _frame(opcode: int, payload: bytes) -> bytes:
    """One unmasked WebSocket frame (server → browser)."""
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return head + payload


class LiveServer(threading.Thread):
    def __init__(
        self,
        host: str,
        port: int,
        workers: Callable[[], dict[str, Any]],
        check_token: Callable[[str], bool],
        max_fps: float = 15,
        quality: int = 60,
    ):
        super().__init__(name="live", daemon=True)
        self.host, self.port = host, port
        self.workers = workers  # camera_id → CameraWorker
        self.check_token = check_token
        self.max_fps, self.quality = max_fps, quality
        self.loop: asyncio.AbstractEventLoop | None = None
        self._clients: dict[str, set[asyncio.Queue]] = {}  # camera_id → message queues
        self._tokens: dict[str, float] = {}  # token → valid until
        self._jpeg_cache: dict[tuple[str, int, int], tuple[bytes, int, int]] = {}
        self.ready = threading.Event()

    # ---------- called from other threads ----------
    def notify(self, camera_id: str | None) -> None:
        """A row for this camera reached Supabase: tell its viewers to reload."""
        if not camera_id or self.loop is None:
            return
        self.loop.call_soon_threadsafe(self._push, camera_id, {"type": "db"})

    def _push(self, camera_id: str, msg: dict) -> None:
        for q in self._clients.get(camera_id, ()):
            if q.qsize() < 20:
                q.put_nowait(msg)

    # ---------- server ----------
    def run(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            server = self.loop.run_until_complete(asyncio.start_server(self._client, self.host, self.port))
        except OSError as exc:
            log.error("Live video server could not start on %s:%s: %s", self.host, self.port, exc)
            self.ready.set()
            return
        log.info("Live video server on http://%s:%s (WebSocket /live/<camera_id>)", self.host, self.port)
        self.ready.set()
        self._server = server  # keep a reference while the loop runs
        self.loop.run_forever()

    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await self._serve(reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError, asyncio.TimeoutError):
            pass
        except Exception as exc:  # never let one viewer stop the server
            log.warning("Live viewer error: %s", exc)
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
        lines = raw.decode("latin-1").split("\r\n")
        try:
            method, target, _ = lines[0].split(" ", 2)
        except ValueError:
            return
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        url = urlsplit(target)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}

        if method != "GET":
            return await self._http(writer, 405, "Method Not Allowed")
        if url.path in ("/", "/health"):
            return await self._http(writer, 200, "OK", f"live video ok, {len(self.workers())} camera(s)\n")
        m = re.fullmatch(r"/live/([0-9a-fA-F-]{36})", url.path)
        key = headers.get("sec-websocket-key")
        if not m or "websocket" not in headers.get("upgrade", "").lower() or not key:
            return await self._http(writer, 404, "Not Found", "use a WebSocket on /live/<camera_id>\n")

        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        writer.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode()
        )
        await writer.drain()

        camera_id = m.group(1).lower()
        if not await self._token_ok(query.get("token", "")):
            await self._send_text(writer, {"type": "error", "msg": "Not signed in (session expired?)"})
            writer.write(_frame(0x8, struct.pack("!H", 4401)))
            await writer.drain()
            return

        try:
            fps = min(max(float(query.get("fps", 10)), 1), self.max_fps)
            width = min(max(int(query.get("w", 640)), 160), 1920)
        except ValueError:
            fps, width = 10, 640

        queue: asyncio.Queue = asyncio.Queue()
        self._clients.setdefault(camera_id, set()).add(queue)
        closed = asyncio.Event()
        reader_task = asyncio.create_task(self._read(reader, writer, closed))
        log.info("Live viewer joined %s (%d watching)", self._camera_name(camera_id), len(self._clients[camera_id]))
        try:
            await self._stream(writer, camera_id, width, fps, queue, closed, query.get("token", ""))
        finally:
            reader_task.cancel()
            self._clients.get(camera_id, set()).discard(queue)
            log.info("Live viewer left %s", self._camera_name(camera_id))

    def _camera_name(self, camera_id: str) -> str:
        w = self.workers().get(camera_id)
        return w.camera["camera_name"] if w else camera_id[:8]

    async def _stream(self, writer, camera_id, width, fps, queue, closed, token: str) -> None:
        last_no, last_status = -1, None
        loop = asyncio.get_running_loop()
        next_token_check = time.monotonic() + TOKEN_OK_SECONDS
        while not closed.is_set():
            started = time.monotonic()
            if started >= next_token_check:  # signed out / session ended: stop the video
                next_token_check = started + TOKEN_OK_SECONDS
                if not await self._token_ok(token):
                    await self._send_text(writer, {"type": "error", "msg": "Session ended. Sign in again."})
                    writer.write(_frame(0x8, struct.pack("!H", 4401)))
                    await writer.drain()
                    return
            while not queue.empty():
                await self._send_text(writer, queue.get_nowait())

            worker = self.workers().get(camera_id)
            frame_no, frame = worker.grabber.latest() if worker else (0, None)
            live = worker is not None and frame is not None and worker.active_status() == "Active"
            boxes = worker.live_boxes if worker else []
            if live and LIVE_SYNC:
                # the picture the AI looked at + the boxes found in it (boxes sit on the people);
                # AI too far behind: the newest picture, without boxes that would be in the wrong place
                synced = worker.live
                if synced is not None and time.time() - synced[3] <= LIVE_SYNC_MAX_AGE:
                    frame_no, frame, boxes = synced[0], synced[1], synced[2]
                else:
                    boxes = []
            if not live:
                msg = ("This camera is not run by this edge box" if worker is None
                       else "Camera off, closed or not connected")
                if last_status != msg:
                    await self._send_text(writer, {"type": "status", "live": False, "msg": msg})
                    last_status = msg
            elif frame_no != last_no:
                if last_status is not None:
                    await self._send_text(writer, {"type": "status", "live": True, "msg": ""})
                    last_status = None
                last_no = frame_no
                jpeg, w, h = await loop.run_in_executor(None, self._encode, camera_id, frame_no, frame, width)
                head = json.dumps(
                    {"f": frame_no, "w": w, "h": h, "boxes": boxes, "counts": worker.counts,
                     "inside": worker.registry.count() if hasattr(worker, "registry") else None,
                     "obstacles": getattr(worker, "obstacles_live", [])},
                    separators=(",", ":"),
                ).encode()
                writer.write(_frame(0x2, struct.pack("!I", len(head)) + head + jpeg))
                await writer.drain()  # slow network: waits here, so the next picture is the newest one

            wait = 1 / fps - (time.monotonic() - started)
            try:
                await asyncio.wait_for(closed.wait(), timeout=max(wait, 0.005))
            except asyncio.TimeoutError:
                pass

    def _encode(self, camera_id: str, frame_no: int, frame, width: int) -> tuple[bytes, int, int]:
        key = (camera_id, frame_no, width)
        hit = self._jpeg_cache.get(key)
        if hit:
            return hit
        h, w = frame.shape[:2]
        if w > width:
            frame = cv2.resize(frame, (width, int(h * width / w)), interpolation=cv2.INTER_AREA)
            h, w = frame.shape[:2]
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        result = (jpeg.tobytes() if ok else b"", w, h)
        if len(self._jpeg_cache) > 32:
            self._jpeg_cache.clear()
        self._jpeg_cache[key] = result
        return result

    async def _read(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, closed: asyncio.Event) -> None:
        """Browser → box: only close and ping matter."""
        try:
            while True:
                b1, b2 = await reader.readexactly(2)
                opcode, n = b1 & 0x0F, b2 & 0x7F
                if n == 126:
                    (n,) = struct.unpack("!H", await reader.readexactly(2))
                elif n == 127:
                    (n,) = struct.unpack("!Q", await reader.readexactly(8))
                mask = await reader.readexactly(4) if b2 & 0x80 else b"\0\0\0\0"
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(await reader.readexactly(n))) if n else b""
                if opcode == 0x8:  # close
                    writer.write(_frame(0x8, data[:2]))
                    break
                if opcode == 0x9:  # ping → pong
                    writer.write(_frame(0xA, data))
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            closed.set()

    async def _token_ok(self, token: str) -> bool:
        if not UUID_RE.match(token):
            return False
        if self._tokens.get(token, 0) > time.time():
            return True
        ok = await asyncio.get_running_loop().run_in_executor(None, self.check_token, token)
        if ok:
            self._tokens[token] = time.time() + TOKEN_OK_SECONDS
        return ok

    @staticmethod
    async def _send_text(writer: asyncio.StreamWriter, msg: dict) -> None:
        writer.write(_frame(0x1, json.dumps(msg).encode()))
        await writer.drain()

    @staticmethod
    async def _http(writer: asyncio.StreamWriter, code: int, reason: str, body: str = "") -> None:
        data = body.encode()
        writer.write(
            f"HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {len(data)}\r\n"
            f"Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n".encode() + data
        )
        await writer.drain()
