"""Remote gateway connectors: registry, ABC, ctx registration, CLI consumer."""

from __future__ import annotations

import asyncio
import logging

import pytest

from gateway.remote_connectors import (
    BUILTIN_SCHEMES,
    RemoteConnector,
    RemoteTarget,
    ServeHandle,
    canonical_scheme,
    get_remote_connector,
    list_remote_connectors,
    register_remote_connector,
    scheme_of,
    unregister_remote_connector,
)
from hermes_cli.plugins import PluginContext, PluginManifest, PluginManager


class FakeConnector(RemoteConnector):
    scheme = "FAKE"
    hint = "paste a fake ticket"
    paste_pattern = r"[a-z2-7]{40,}"

    def __init__(self):
        self.served = []
        self.torn_down = []

    async def serve(self, gateway_url, config=None):
        self.served.append((gateway_url, config))

        return ServeHandle(ticket="fake://ticket-123", target_url=gateway_url,
                           teardown=self._record("serve"))

    async def connect(self, saved_url):
        return RemoteTarget(base_url="http://127.0.0.1:59999", host_label="fake:ticket",
                            teardown=self._record("connect"))

    def _record(self, what):
        async def _stop():
            self.torn_down.append(what)

        return _stop


@pytest.fixture(autouse=True)
def _clean_registry():
    yield
    for scheme in list(list_remote_connectors()):
        unregister_remote_connector(scheme)


class TestSchemeHelpers:
    def test_canonical_scheme(self):
        assert canonical_scheme(" IRoh ") == "iroh"
        assert canonical_scheme("tailscale+ssh") == "tailscale+ssh"
        assert canonical_scheme("bad scheme") == ""
        assert canonical_scheme("1bad") == ""
        assert canonical_scheme(None) == ""

    def test_scheme_of(self):
        assert scheme_of("iroh://abc123") == "iroh"
        assert scheme_of("HTTPS://x.test") == "https"
        assert scheme_of("homelab.local:9119") == ""
        assert scheme_of(None) == ""


class TestRegistry:
    def test_register_lowercases_and_dispatches(self):
        connector = FakeConnector()
        register_remote_connector(connector)

        assert connector.scheme == "fake"
        assert get_remote_connector("fake://ticket") is connector
        assert get_remote_connector("fake") is connector
        assert get_remote_connector("http://plain.remote") is None
        assert get_remote_connector("not-a-scheme-url-noise") is None

    def test_builtin_schemes_not_registrable(self):
        async def _noop_serve(self, gateway_url, config=None):
            return ServeHandle(target_url=gateway_url)

        for scheme in sorted(BUILTIN_SCHEMES):
            probe = type("P", (RemoteConnector,), {"scheme": scheme, "serve": _noop_serve})()

            with pytest.raises(ValueError, match="built-in"):
                register_remote_connector(probe)

    def test_duplicate_scheme_raises(self):
        register_remote_connector(FakeConnector())

        with pytest.raises(ValueError, match="already registered"):
            register_remote_connector(FakeConnector())

    def test_wrong_type_raises(self):
        with pytest.raises(TypeError):
            register_remote_connector({"scheme": "fake", "serve": None})

    def test_invalid_scheme_raises(self):
        async def _noop_serve(self, gateway_url, config=None):
            return ServeHandle(target_url=gateway_url)

        probe = type("P", (RemoteConnector,), {"scheme": "not valid!", "serve": _noop_serve})()

        with pytest.raises(ValueError, match="invalid scheme"):
            register_remote_connector(probe)

    def test_unregister_idempotent_then_reusable(self):
        register_remote_connector(FakeConnector())
        unregister_remote_connector("fake")
        unregister_remote_connector("fake")  # idempotent
        assert get_remote_connector("fake://x") is None

        second = FakeConnector()
        register_remote_connector(second)
        assert get_remote_connector("fake://x") is second

    def test_list_returns_snapshot(self):
        register_remote_connector(FakeConnector())
        snapshot = list_remote_connectors()
        snapshot.clear()
        assert "fake" in list_remote_connectors()


class TestABC:
    def test_serve_is_abstract(self):
        with pytest.raises(TypeError):
            RemoteConnector()

    def test_connect_optional_raises_not_implemented(self):
        class ServeOnly(RemoteConnector):
            scheme = "onlyserve"

            async def serve(self, gateway_url, config=None):
                return ServeHandle(target_url=gateway_url)

        async def run():
            with pytest.raises(NotImplementedError):
                await ServeOnly().connect("onlyserve://x")

        asyncio.run(run())

    def test_claims_and_normalize(self):
        connector = FakeConnector()

        assert connector.claims("aoeu" * 11) is True
        assert connector.claims("homelab.local:9119") is False
        assert connector.claims("") is False
        assert connector.normalize("  fake://abc123  ") == "fake://abc123"

    def test_bad_paste_pattern_never_claims(self):
        connector = FakeConnector()
        connector.paste_pattern = "([unclosed"
        assert connector.claims("anything") is False


class TestHandles:
    def test_serve_handle_stop_once_only_and_swallows(self):
        calls = []

        async def boom():
            calls.append(1)
            raise RuntimeError("already closed")

        async def run():
            handle = ServeHandle(ticket="t", teardown=boom)
            await handle.stop()
            await handle.stop()  # idempotent: teardown consumed once

            assert calls == [1]

        asyncio.run(run())

    def test_remote_target_stop_without_teardown(self):
        async def run():
            await RemoteTarget(base_url="http://127.0.0.1:1").stop()

        asyncio.run(run())

    def test_serve_and_connect_round_trip(self):
        connector = FakeConnector()
        register_remote_connector(connector)

        async def run():
            handle = await get_remote_connector("fake://x").serve("http://127.0.0.1:9119", {"relays": ["r"]})

            assert handle.ticket == "fake://ticket-123"
            assert connector.served == [("http://127.0.0.1:9119", {"relays": ["r"]})]

            target = await get_remote_connector("fake://ticket-123").connect("fake://ticket-123")

            assert target.base_url == "http://127.0.0.1:59999"
            await handle.stop()
            await target.stop()
            assert connector.torn_down == ["serve", "connect"]

        asyncio.run(run())


class TestCtxRegistration:
    def _ctx(self):
        return PluginContext(PluginManifest(name="test-plugin", source="user"), PluginManager())

    def test_registers_and_persists(self):
        ctx = self._ctx()
        handle = ctx.register_remote_connector(FakeConnector())

        assert handle is not None
        assert "fake" in list_remote_connectors()

    def test_duplicate_warns_and_ignores(self, caplog):
        ctx = self._ctx()

        ctx.register_remote_connector(FakeConnector())

        with caplog.at_level(logging.WARNING, logger="hermes_cli.plugins"):
            result = ctx.register_remote_connector(FakeConnector())

        assert result is None
        assert "already registered" in caplog.text

    def test_builtin_scheme_warns_and_ignores(self, caplog):
        ctx = self._ctx()
        https = type("P", (RemoteConnector,), {
            "scheme": "https",
            "serve": lambda self, gateway_url, config=None: ServeHandle(target_url=gateway_url),
        })()

        with caplog.at_level(logging.WARNING, logger="hermes_cli.plugins"):
            assert ctx.register_remote_connector(https) is None

        assert "built-in" in caplog.text

    def test_wrong_type_warns_and_ignores(self, caplog):
        ctx = self._ctx()

        with caplog.at_level(logging.WARNING, logger="hermes_cli.plugins"):
            assert ctx.register_remote_connector(object()) is None

        assert "RemoteConnector" in caplog.text

    def test_noop_context_accepts_the_call(self):
        from plugins.plugin_loader import NoopPluginContext

        assert NoopPluginContext().register_remote_connector(FakeConnector()) is None


class TestCliConsumer:
    def _parse(self, argv):
        import argparse

        from hermes_cli.subcommands.remote import build_remote_parser

        parser = argparse.ArgumentParser()
        subparsers = parser.add_subparsers()
        build_remote_parser(subparsers)

        return parser.parse_args(["remote"] + argv)

    def test_parser_shapes(self):
        assert self._parse(["list"]).remote_action == "list"
        args = self._parse(["serve", "--scheme", "fake"])

        assert args.gateway_url == "http://127.0.0.1:9119"
        assert self._parse(["connect", "iroh://abc"]).url == "iroh://abc"

    def test_list_empty_and_populated(self, capsys, monkeypatch):
        from hermes_cli.subcommands import remote as remote_cmd

        monkeypatch.setattr("hermes_cli.plugins.discover_plugins", lambda *a, **k: None)

        assert remote_cmd.cmd_remote(self._parse(["list"])) == 0
        assert "No remote gateway connectors" in capsys.readouterr().out

        register_remote_connector(FakeConnector())

        assert remote_cmd.cmd_remote(self._parse(["list"])) == 0
        out = capsys.readouterr().out

        assert "fake://" in out and "serves+dials" in out

    def test_unknown_scheme_fails_closed(self, capsys, monkeypatch):
        from hermes_cli.subcommands import remote as remote_cmd

        monkeypatch.setattr("hermes_cli.plugins.discover_plugins", lambda *a, **k: None)

        assert remote_cmd.cmd_remote(self._parse(["serve", "--scheme", "ghost"])) == 2
        assert remote_cmd.cmd_remote(self._parse(["connect", "ghost://x"])) == 2
        assert "No connector registered" in capsys.readouterr().err

    def test_https_needs_no_connector(self, capsys, monkeypatch):
        from hermes_cli.subcommands import remote as remote_cmd

        monkeypatch.setattr("hermes_cli.plugins.discover_plugins", lambda *a, **k: None)

        assert remote_cmd.cmd_remote(self._parse(["connect", "https://plain.remote"])) == 2
        assert "need no connector" in capsys.readouterr().err
