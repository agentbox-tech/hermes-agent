"""``hermes remote`` subcommand — remote gateway connectors.

The concrete consumer of the ``gateway.remote_connectors`` registry:

* ``hermes remote list``               — which transports are installed
* ``hermes remote serve``            — accept side: expose this box's gateway
  over a connector's transport and print the pairing artifact
* ``hermes remote connect <url>``     — dial side: turn a saved
  ``scheme://…`` url into a live local access point and hold it open

Plain ``http(s)`` remotes need none of this — they are core, unchanged.
"""

from __future__ import annotations

import argparse
import asyncio
import sys


def build_remote_parser(subparsers: argparse._SubParsersAction) -> None:
    """Attach the ``remote`` subcommand to ``subparsers``."""
    parser = subparsers.add_parser(
        "remote",
        help="Remote gateway connectors: serve this box / dial a remote over plugin transports",
        description="Manage remote gateway connectors — scheme-registered transports "
        "(iroh, tailscale, …) that pair a Hermes desktop/CLI with a gateway without "
        "port-forwarding. Plain https remotes are core and need no connector.")
    actions = parser.add_subparsers(dest="remote_action", required=True)

    actions.add_parser("list", aliases=["ls"], help="List installed connectors and what they do")

    serve = actions.add_parser("serve", help="Expose the local gateway over a connector transport")
    serve.add_argument("--scheme", required=True, help="Connector scheme to serve with (see 'hermes remote list')")
    serve.add_argument("--gateway-url", default="http://127.0.0.1:9119",
                       help="Local gateway/dashboard URL to expose (default: %(default)s)")

    connect = actions.add_parser("connect", help="Dial a saved scheme://… url to a local access point")
    connect.add_argument("url", help="Saved connector URL, e.g. iroh://<ticket>")

    parser.set_defaults(func=cmd_remote)


def cmd_remote(args: argparse.Namespace) -> int:
    from gateway.remote_connectors import RemoteConnector, get_remote_connector, list_remote_connectors, scheme_of
    from hermes_cli.plugins import discover_plugins

    discover_plugins()
    action = args.remote_action

    if action in ("list", "ls"):
        connectors = list_remote_connectors()

        if not connectors:
            print("No remote gateway connectors installed.")
            print("Install one (e.g. the iroh connector) as a hermes plugin, or use plain https remotes.")
            return 0

        for scheme, connector in sorted(connectors.items()):
            hint = f" — {connector.hint}" if connector.hint else ""
            dials = "serves+dials" if type(connector).connect is not RemoteConnector.connect else "serves"
            print(f"  {scheme}://  [{dials}]{hint}")

        return 0

    if action == "serve":
        scheme = args.scheme.strip().lower()
        connector = get_remote_connector(scheme)

        if connector is None:
            print(f"No connector registered for scheme '{scheme}://'. Run 'hermes remote list'.", file=sys.stderr)
            return 2

        return _run_forever(connector.serve(args.gateway_url), mode="serve")

    if action == "connect":
        scheme = scheme_of(args.url)

        if scheme in ("http", "https", ""):
            print("Plain http(s) urls need no connector — point the app at them directly.", file=sys.stderr)
            return 2

        connector = get_remote_connector(args.url)

        if connector is None:
            print(f"No connector registered for scheme '{scheme}://'. Run 'hermes remote list'.", file=sys.stderr)
            return 2

        return _run_forever(connector.connect(args.url), mode="connect")

    return 2


def _run_forever(coro, *, mode: str) -> int:
    """Run a serve/connect coroutine until Ctrl-C, always tearing the handle down."""

    async def _main() -> int:
        handle = await coro

        if mode == "serve":
            ticket = getattr(handle, "ticket", "") or "(no ticket)"
            print(f"serving {handle.target_url} — pair with:\n  {ticket}")
            print("Ctrl-C to stop.")
        else:
            label = getattr(handle, "host_label", "") or ""
            print(f"dialled: access point {handle.base_url}" + (f" ({label})" if label else ""))
            print("Ctrl-C to close.")

        try:
            await asyncio.Event().wait()
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            stop = getattr(handle, "stop", None)

            if stop is not None:
                await stop()

        return 0

    try:
        return asyncio.run(_main())
    except KeyboardInterrupt:
        return 0
    except NotImplementedError as exc:
        print(str(exc), file=sys.stderr)
        return 2
