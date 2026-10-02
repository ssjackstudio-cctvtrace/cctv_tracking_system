"""Small Supabase client (REST + Storage) for the edge box.

Uses the SECRET key, sent on the `apikey` header only: Supabase rejects the
new sb_secret_ keys on `Authorization: Bearer` because it expects a JWT there.
The secret key bypasses Row Level Security, so keep it on the box only.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import requests


class SupabaseError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Supabase:
    def __init__(self, url: str, secret_key: str, timeout: float = 15.0):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.http = requests.Session()
        self.http.headers.update({"apikey": secret_key})

    # ---------- REST (tables) ----------
    def select(self, table: str, columns: str = "*", **filters: str) -> list[dict[str, Any]]:
        """select("camera", "camera_id,camera_name", edge_device_id="eq.<id>")"""
        params = {"select": columns, **filters}
        r = self.http.get(f"{self.url}/rest/v1/{table}", params=params, timeout=self.timeout)
        self._check(r)
        return r.json()

    def insert(self, table: str, rows: dict[str, Any] | list[dict[str, Any]]) -> None:
        r = self.http.post(
            f"{self.url}/rest/v1/{table}",
            json=rows,
            headers={"Prefer": "return=minimal"},
            timeout=self.timeout,
        )
        self._check(r)

    def update(self, table: str, values: dict[str, Any], **filters: str) -> None:
        r = self.http.patch(
            f"{self.url}/rest/v1/{table}",
            params=filters,
            json=values,
            headers={"Prefer": "return=minimal"},
            timeout=self.timeout,
        )
        self._check(r)

    def rpc(self, function: str, args: dict[str, Any]) -> Any:
        r = self.http.post(f"{self.url}/rest/v1/rpc/{function}", json=args, timeout=self.timeout)
        self._check(r)
        return r.json()

    # ---------- Storage ----------
    def upload(self, bucket: str, path: str, data: bytes, content_type: str = "image/jpeg") -> None:
        r = self.http.post(
            f"{self.url}/storage/v1/object/{bucket}/{quote(path)}",
            data=data,
            headers={"Content-Type": content_type, "x-upsert": "true", "cache-control": "max-age=0"},
            timeout=self.timeout,
        )
        self._check(r)

    def signed_url(self, bucket: str, path: str, expires_in: int) -> str:
        r = self.http.post(
            f"{self.url}/storage/v1/object/sign/{bucket}/{quote(path)}",
            json={"expiresIn": expires_in},
            timeout=self.timeout,
        )
        self._check(r)
        signed = r.json().get("signedURL") or r.json().get("signedUrl")
        if not signed:
            raise SupabaseError(r.status_code, f"No signed URL in response: {r.text[:200]}")
        return signed if signed.startswith("http") else f"{self.url}/storage/v1{signed}"

    @staticmethod
    def _check(r: requests.Response) -> None:
        if r.status_code >= 400:
            raise SupabaseError(
                r.status_code, f"{r.request.method} {r.url.split('?')[0]} → {r.status_code}: {r.text[:300]}"
            )
