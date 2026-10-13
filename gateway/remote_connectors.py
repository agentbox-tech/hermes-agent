"""Remote gateway connectors — the scheme-dispatch seam for non-HTTP transports.

The server half of the remote gateway connectors extension point (the desktop
half lives in ``apps/desktop/electron/remote-connector-registry.ts`` and shares
its contract: a connector registers a URL scheme and owns turning pairing
material into a live transport; core never parses it).

Two roles, one ABC:

* ``serve()`` — the ACCEPT side: expose a local gateway (the dashboard /
  web_server URL) over the connector's transport and hand back a pairing
  artifact (ticket, address, hostname…) that a client can dial. This is what
  a headless MyAgent box runs: the connector runs beside the gateway and
  publishes its ticket; nobody SSHes in to port-forward anymore.
* ``connect()`` — the DIAL side (optional, for headless CLI/automation):
  turn a saved ``scheme://…`` url into a live ``http://127.0.0.1:<port>``
  access point. Everything downstream consumes plain HTTP; the transport is
  invisible below that line.

Registry semantics mirror ``agent.context_references`` (this project's
established scheme-registry shape): duplicate registrations raise
``ValueError``, the built-in ``http``/``https`` schemes are reserved to core
and not registrable, and ``get*`` returns a snapshot copy.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

#: Built-in transports stay core; a connector registering one is a bug.
BUILTIN_SCHEMES = frozenset({"http", "https"})

#: RFC 3986 scheme token, lowercased at registration time.
_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*$")


@dataclass
class ServeHandle:
    """Accept-side handle: what the world dials, and how to stop serving.

    ``ticket`` is the pairing artifact (connector-shaped: an iroh ticket, a
    tailscale hostname, …). Core stores/serves it verbatim — it is opaque.
    ``target_url`` is what the connector binds its access point on (the
    gateway url it forwards to).
    """

    ticket: str = ""
    target_url: str = ""
    teardown: Callable[[], Awaitable[None]] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    async def stop(self) -> None:
        """Tear down the accept side. Idempotent; errors are swallowed."""
        teardown, self.teardown = self.teardown, None

        if teardown is not None:
            try:
                await teardown()
            except Exception:  # noqa: BLE001 - shutdown must not raise
                pass


@dataclass
class RemoteTarget:
    """Dial-side result: a live loopback origin plus its teardown."""

    base_url: str
    teardown: Callable[[], Awaitable[None]] | None = None
    host_label: str = ""

    async def stop(self) -> None:
        teardown, self.teardown = self.teardown, None

        if teardown is not None:
            try:
                await teardown()
            except Exception:  # noqa: BLE001 - shutdown must not raise
                pass


class RemoteConnector(ABC):
    """Base class for remote gateway connector plugins.

    Registered via ``ctx.register_remote_connector(impl())`` in a plugin's
    ``register(ctx)``; dispatched by URL scheme. ``serve()`` is the core
    obligation (a box that only ever dials can skip it by raising
    ``NotImplementedError`` from serve and implementing ``connect()``).
    """

    #: Dispatch scheme, WITHOUT '://' (e.g. 'iroh'). Lowercased on register.
    scheme: str = ""
    #: Human hint for connection-setup UIs ("paste the ticket from the box").
    hint: str = ""
    #: Regex SOURCE for opaque pasted pairing material without the scheme
    #: prefix (bare tickets). Core tests it generically; it never hardcodes
    #: a pairing format.
    paste_pattern: str = ""

    @abstractmethod
    async def serve(self, gateway_url: str, config: dict[str, Any] | None = None) -> ServeHandle:
        """Expose ``gateway_url`` over this transport.

        Returns a :class:`ServeHandle` whose ``ticket`` is the pairing
        artifact to publish. ``config`` is the connector's own config block
        (``plugins.<name>`` section of config.yaml) — connector-interpreted,
        core never reads it.
        """

    async def connect(self, saved_url: str) -> RemoteTarget:
        """Dial ``saved_url`` (``scheme://…``) to a loopback access point.

        Optional: connectors that only serve may omit it. Implementations
        must be idempotent per canonical url (reuse the live pipe).
        """
        raise NotImplementedError(f"connector '{self.scheme}' does not implement connect()")

    def normalize(self, saved_url: str) -> str:
        """Canonical saved form for this scheme. Default: strip whitespace."""
        return saved_url.strip()

    def claims(self, raw: str) -> bool:
        """Whether a scheme-less pasted value belongs to this connector."""
        raw = raw.strip()

        if not raw or not self.paste_pattern:
            return False

        try:
            return re.compile(self.paste_pattern, re.IGNORECASE).fullmatch(raw) is not None
        except re.error:
            return False


# ── Registry ──────────────────────────────────────────────────────────────────

_connectors: dict[str, RemoteConnector] = {}


def canonical_scheme(scheme: Any) -> str:
    """Validate + lowercase a scheme token; '' for anything invalid."""
    if not isinstance(scheme, str):
        return ""

    value = scheme.strip().lower()

    return value if _SCHEME_RE.match(value) else ""


def scheme_of(url: str) -> str:
    """``iroh://abc`` → ``iroh``; ``http://x`` → ``http``; else ``''``."""
    if not isinstance(url, str):
        return ""

    match = re.match(r"^([a-z][a-z0-9+.-]*)://", url.strip(), re.IGNORECASE)

    return canonical_scheme(match.group(1)) if match else ""


def register_remote_connector(connector: RemoteConnector) -> None:
    """Register a connector at its scheme. Raises on anything unsafe:
    wrong type, invalid scheme, built-in scheme, duplicate claim."""
    if not isinstance(connector, RemoteConnector):
        raise TypeError("connector must be a RemoteConnector instance")

    scheme = canonical_scheme(connector.scheme)

    if not scheme:
        raise ValueError(f"invalid scheme {connector.scheme!r}")

    if scheme in BUILTIN_SCHEMES:
        raise ValueError(f"scheme '{scheme}' is a built-in transport and is not registrable")

    if scheme in _connectors:
        raise ValueError(f"scheme '{scheme}' is already registered by '{_connectors[scheme].scheme}'")

    connector.scheme = scheme
    _connectors[scheme] = connector


def unregister_remote_connector(scheme: str) -> None:
    """Remove a connector by scheme (idempotent)."""
    _connectors.pop(canonical_scheme(scheme), None)


def get_remote_connector(url_or_scheme: str) -> RemoteConnector | None:
    """The connector owning ``url_or_scheme``'s scheme, or None for
    http(s)/scheme-less values."""
    scheme = canonical_scheme(url_or_scheme) if "://" not in str(url_or_scheme) else scheme_of(url_or_scheme)

    return _connectors.get(scheme) if scheme else None


def list_remote_connectors() -> dict[str, RemoteConnector]:
    """Snapshot of registered connectors keyed by canonical scheme."""
    return dict(_connectors)
