"""AIRadar Python SDK — sync and async clients with L402/x402 payment handling."""

from __future__ import annotations

import base64
import json
from typing import Any, Callable, Optional

try:
    import httpx
    _HAS_HTTPX = True
except ImportError:
    _HAS_HTTPX = False

try:
    import requests as _requests
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

if not _HAS_HTTPX and not _HAS_REQUESTS:
    raise ImportError("Install httpx or requests: pip install airadar")

__version__ = "0.1.0"
_USER_AGENT = f"airadar-python/{__version__}"


class AIRadarError(Exception):
    def __init__(self, message: str, *, status: int | None = None, data: dict | None = None):
        super().__init__(message)
        self.status = status
        self.data = data or {}


def _decode_x402_requirements(header: str) -> dict:
    padded = header + "=" * (-len(header) % 4)
    return json.loads(base64.b64decode(padded))


# ── Sync client ───────────────────────────────────────────────────────────────

class AIRadarClient:
    """Sync client for AIRadar with automatic L402/x402 payment handling.

    Args:
        base_url: API base URL (default: https://airadar.fyi).
        lightning: Callable ``(bolt11: str) -> preimage: str`` — pays a
            Lightning invoice and returns the hex preimage.
        x402: Callable ``(requirements: dict) -> base64_payload: str`` — signs
            a USDC/USDT payment and returns the base64 X-PAYMENT payload.
        prefer: Which payment method to try first (``"lightning"`` or ``"x402"``).
        timeout: HTTP timeout in seconds.
    """

    def __init__(
        self,
        base_url: str = "https://airadar.fyi",
        lightning: Optional[Callable[[str], str]] = None,
        x402: Optional[Callable[[dict], str]] = None,
        prefer: str = "lightning",
        timeout: float = 30.0,
    ):
        self.base = base_url.rstrip("/")
        self._lightning = lightning
        self._x402 = x402
        self.prefer = prefer
        self._timeout = timeout
        if _HAS_HTTPX:
            self._httpx = httpx.Client(headers={"User-Agent": _USER_AGENT}, timeout=timeout)
        else:
            self._httpx = None

    def __enter__(self) -> "AIRadarClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._httpx is not None:
            self._httpx.close()

    def _raw_request(self, method: str, url: str, params: dict, body: Any, headers: dict) -> Any:
        """Execute HTTP request, returns a response-like object with .status_code, .json(), .reason."""
        if self._httpx is not None:
            return self._httpx.request(method, url, params=params or None, json=body, headers=headers)
        # requests fallback
        h = {"User-Agent": _USER_AGENT, **headers}
        resp = _requests.request(
            method, url, params=params or None, json=body, headers=h, timeout=self._timeout
        )
        resp.is_success = resp.ok
        resp.reason_phrase = resp.reason
        return resp

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[dict] = None,
        body: Optional[Any] = None,
        headers: Optional[dict] = None,
        raw: bool = False,
    ) -> Any:
        url = f"{self.base}{path}"
        params = {k: v for k, v in (query or {}).items() if v is not None}
        h = headers or {}

        resp = self._raw_request(method, url, params, body, h)

        if resp.status_code == 402:
            try:
                data = resp.json()
            except Exception:
                data = {}
            payment_h = self._handle402(data)
            resp = self._raw_request(method, url, params, body, {**h, **payment_h})

        if raw:
            return resp

        if not resp.is_success:
            try:
                err = resp.json()
            except Exception:
                err = {"error": resp.reason_phrase}
            raise AIRadarError(err.get("error", resp.reason_phrase), status=resp.status_code, data=err)

        return resp.json()

    def _handle402(self, data: dict) -> dict:
        opts = data.get("payment_options")
        if not opts:
            raise AIRadarError("Payment required", status=402, data=data)

        l402_opts = opts.get("lightning")
        x402_opts = opts.get("crypto") or opts.get("usdc")

        order = ["x402", "l402"] if self.prefer == "x402" else ["l402", "x402"]

        for method in order:
            if method == "l402" and self._lightning and l402_opts:
                return self._pay_l402(l402_opts)
            if method == "x402" and self._x402 and x402_opts:
                return self._pay_x402(x402_opts)

        e = AIRadarError(
            "Payment required — configure a lightning or x402 handler",
            status=402, data=data,
        )
        raise e

    def _pay_l402(self, opts: dict) -> dict:
        preimage = self._lightning(opts["invoice"])
        return {"Authorization": f"L402 {opts['payment_hash']}:{preimage}"}

    def _pay_x402(self, opts: dict) -> dict:
        header = opts.get("payment_required_header", "")
        requirements = _decode_x402_requirements(header)
        payload = self._x402(requirements)
        return {"X-PAYMENT": payload}

    # ── Shortcuts ─────────────────────────────────────────────────────────────

    def get(self, path: str, **kw: Any) -> Any:
        return self.request("GET", path, **kw)

    def post(self, path: str, **kw: Any) -> Any:
        return self.request("POST", path, **kw)

    # ── Convenience methods ───────────────────────────────────────────────────

    def health(self) -> dict:
        return self.get("/health")

    def free(self) -> dict:
        """Top 3 online providers — free, no payment."""
        return self.get("/free")

    def providers(self, network: str | None = None, online_only: bool = True) -> dict:
        """Full provider directory. Requires payment."""
        return self.get("/providers", query={"network": network, "online": str(online_only).lower()})

    def gateway_models(self) -> dict:
        """List gateway models with tier/pricing — free."""
        return self.get("/v1/models")

    def reputation(self, agent_id: str) -> dict:
        """Reputation score for a wallet / npub / pubkey — free."""
        return self.get(f"/reputation/{agent_id}")

    def reputation_leaderboard(self) -> dict:
        """Top-agents leaderboard — free."""
        return self.get("/reputation")

    def search(self, query: str, n: int = 5, type: str = "web") -> dict:
        """Web search. Requires payment."""
        return self.get("/search", query={"q": query, "n": n, "type": type})

    def chat(self, model: str, messages: list[dict], **kwargs: Any) -> dict:
        """OpenAI-compatible chat inference. Requires payment."""
        return self.post("/v1/chat/completions", body={"model": model, "messages": messages, **kwargs})


# ── Async client ──────────────────────────────────────────────────────────────

class AsyncAIRadarClient:
    """Async client for AIRadar. Same interface as :class:`AIRadarClient` but
    all methods are coroutines — use ``await`` on every call.

    The ``lightning`` and ``x402`` callbacks may also be async coroutines.
    """

    def __init__(
        self,
        base_url: str = "https://airadar.fyi",
        lightning: Optional[Callable] = None,
        x402: Optional[Callable] = None,
        prefer: str = "lightning",
        timeout: float = 30.0,
    ):
        if not _HAS_HTTPX:
            raise ImportError("AsyncAIRadarClient requires httpx: pip install 'airadar[async]'")
        self.base = base_url.rstrip("/")
        self._lightning = lightning
        self._x402 = x402
        self.prefer = prefer
        self._client = httpx.AsyncClient(
            headers={"User-Agent": _USER_AGENT},
            timeout=timeout,
        )

    async def __aenter__(self) -> "AsyncAIRadarClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self._client.aclose()

    async def close(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[dict] = None,
        body: Optional[Any] = None,
        headers: Optional[dict] = None,
        raw: bool = False,
    ) -> Any:
        url = f"{self.base}{path}"
        params = {k: v for k, v in (query or {}).items() if v is not None}
        h = headers or {}

        resp = await self._client.request(method, url, params=params or None, json=body, headers=h)

        if resp.status_code == 402:
            try:
                data = resp.json()
            except Exception:
                data = {}
            payment_h = await self._handle402(data)
            resp = await self._client.request(method, url, params=params or None, json=body, headers={**h, **payment_h})

        if raw:
            return resp

        if not resp.is_success:
            try:
                err = resp.json()
            except Exception:
                err = {"error": resp.reason_phrase}
            raise AIRadarError(err.get("error", resp.reason_phrase), status=resp.status_code, data=err)

        return resp.json()

    async def _handle402(self, data: dict) -> dict:
        opts = data.get("payment_options")
        if not opts:
            raise AIRadarError("Payment required", status=402, data=data)

        l402_opts = opts.get("lightning")
        x402_opts = opts.get("crypto") or opts.get("usdc")

        order = ["x402", "l402"] if self.prefer == "x402" else ["l402", "x402"]

        import inspect

        for method in order:
            if method == "l402" and self._lightning and l402_opts:
                preimage = self._lightning(l402_opts["invoice"])
                if inspect.isawaitable(preimage):
                    preimage = await preimage
                return {"Authorization": f"L402 {l402_opts['payment_hash']}:{preimage}"}
            if method == "x402" and self._x402 and x402_opts:
                header = x402_opts.get("payment_required_header", "")
                requirements = _decode_x402_requirements(header)
                payload = self._x402(requirements)
                if inspect.isawaitable(payload):
                    payload = await payload
                return {"X-PAYMENT": payload}

        raise AIRadarError(
            "Payment required — configure a lightning or x402 handler",
            status=402, data=data,
        )

    async def get(self, path: str, **kw: Any) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw: Any) -> Any:
        return await self.request("POST", path, **kw)

    async def health(self) -> dict:
        return await self.get("/health")

    async def free(self) -> dict:
        return await self.get("/free")

    async def providers(self, network: str | None = None, online_only: bool = True) -> dict:
        return await self.get("/providers", query={"network": network, "online": str(online_only).lower()})

    async def gateway_models(self) -> dict:
        return await self.get("/v1/models")

    async def reputation(self, agent_id: str) -> dict:
        return await self.get(f"/reputation/{agent_id}")

    async def reputation_leaderboard(self) -> dict:
        return await self.get("/reputation")

    async def search(self, query: str, n: int = 5, type: str = "web") -> dict:
        return await self.get("/search", query={"q": query, "n": n, "type": type})

    async def chat(self, model: str, messages: list[dict], **kwargs: Any) -> dict:
        return await self.post("/v1/chat/completions", body={"model": model, "messages": messages, **kwargs})
