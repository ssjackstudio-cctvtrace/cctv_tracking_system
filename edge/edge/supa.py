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

    def delete(self, table: str, **filters: str) -> None:
        """delete("body_template", biometric_photo_id="eq.<id>") — always pass a filter."""
        if not filters:
            raise ValueError("delete() needs a filter")
        r = self.http.delete(f"{self.url}/rest/v1/{table}", params=filters,
                             headers={"Prefer": "return=minimal"}, timeout=self.timeout)
        self._check(r)

    def rpc(self, function: str, args: dict[str, Any]) -> Any:
        r = self.http.post(f"{self.url}/rest/v1/rpc/{function}", json=args, timeout=self.timeout)
        self._check(r)
        return r.json()

    def admin_ok(self, token: str) -> bool:
        """True when token is a signed-in website admin session (for live video).
        Uses admin_check() like the website does; falls back to admin_session."""
        try:
            r = self.http.post(f"{self.url}/rest/v1/rpc/admin_check", json={},
                               headers={"x-admin-token": token}, timeout=self.timeout)
            if r.status_code < 400:
                return bool(r.json())
        except requests.RequestException:
            pass
        try:
            from datetime import datetime, timezone

            rows = self.select("admin_session", "admin_id", token=f"eq.{token}",
                               expires_at=f"gt.{datetime.now(timezone.utc).isoformat()}")
            return bool(rows)
        except Exception:
            return False

    # ---------- Storage ----------
    def upload(self, bucket: str, path: str, data: bytes, content_type: str = "image/jpeg") -> None:
        r = self.http.post(
            f"{self.url}/storage/v1/object/{bucket}/{quote(path)}",
            data=data,
            headers={"Content-Type": content_type, "x-upsert": "true", "cache-control": "max-age=0"},
            timeout=self.timeout,
        )
        self._check(r)

    def download(self, bucket: str, path: str) -> bytes:
        """A file from a private bucket (e.g. a biometric photo)."""
        r = self.http.get(f"{self.url}/storage/v1/object/authenticated/{bucket}/{quote(path)}",
                          timeout=self.timeout)
        self._check(r)
        return r.content

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

    def list_objects(self, bucket: str, prefix: str = "", limit: int = 1000, offset: int = 0) -> list[dict[str, Any]]:
        """Files and folders directly under prefix (a folder has "id": null)."""
        r = self.http.post(
            f"{self.url}/storage/v1/object/list/{bucket}",
            json={"prefix": prefix, "limit": limit, "offset": offset, "sortBy": {"column": "name", "order": "asc"}},
            timeout=self.timeout,
        )
        self._check(r)
        return r.json()

    def remove(self, bucket: str, paths: list[str]) -> None:
        """Delete these files from the bucket (Storage API: deleting storage.objects
        rows with SQL is not allowed)."""
        if not paths:
            return
        r = self.http.delete(f"{self.url}/storage/v1/object/{bucket}", json={"prefixes": paths},
                             timeout=self.timeout)
        self._check(r)

    @staticmethod
    def _check(r: requests.Response) -> None:
        if r.status_code >= 400:
            raise SupabaseError(
                r.status_code, f"{r.request.method} {r.url.split('?')[0]} → {r.status_code}: {r.text[:300]}"
            )
