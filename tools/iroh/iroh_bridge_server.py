"""iroh -> TCP bridge (PoC): accepts iroh connections, pipes each
bidirectional stream to a local TCP target (the hermes dashboard).

Run beside `hermes dashboard`. v0 of the iroh transport experiment;
will fold into web_server config once proven.
"""
import asyncio, pathlib, sys

import iroh
from iroh import iroh_ffi  # type: ignore[attr-defined]  # dynamically attached submodule

TARGET_HOST, TARGET_PORT = "127.0.0.1", 9119
ALPN = b"hermes-http/0"
KEYFILE = pathlib.Path.home() / ".hermes" / "iroh-http.key"
READ_CHUNK = 64 * 1024


def load_secret_key() -> bytes:
    if KEYFILE.exists():
        return KEYFILE.read_bytes()
    sk = iroh.SecretKey.generate().to_bytes()
    KEYFILE.parent.mkdir(parents=True, exist_ok=True)
    KEYFILE.write_bytes(sk)
    KEYFILE.chmod(0o600)
    return sk


async def pipe_stream(stream):
    try:
        target_reader, target_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
    except Exception as e:
        print(f"pipe: cannot reach {TARGET_HOST}:{TARGET_PORT}: {e}", flush=True)
        try:
            await stream.send.reset(0)
        except Exception:
            pass
        return
    rs, ss = stream.recv(), stream.send()

    async def iroh_to_tcp():
        try:
            while True:
                data = await rs.read(READ_CHUNK)
                if not data:
                    break
                target_writer.write(data)
                await target_writer.drain()
        finally:
            target_writer.close()
            try:
                await target_writer.wait_closed()
            except Exception:
                pass

    async def tcp_to_iroh():
        try:
            while True:
                data = await target_reader.read(READ_CHUNK)
                if not data:
                    break
                await ss.write(data)
        finally:
            await ss.finish()

    await asyncio.gather(iroh_to_tcp(), tcp_to_iroh(), return_exceptions=True)


async def main():
    iroh.iroh_ffi.uniffi_set_event_loop(asyncio.get_running_loop())
    b = iroh.EndpointBuilder()
    b.apply_n0()
    b.alpns([ALPN])
    b.secret_key(load_secret_key())
    ep = await b.bind()
    addr = ep.addr()
    print("nodeid:", ep.id(), flush=True)
    ticket = str(iroh.EndpointTicket.from_addr(addr))  # type: ignore[attr-defined]
    print("ticket:", ticket, flush=True)
    # Share the fresh ticket with the client bridge via the mounted home:
    # relay hints change every bind, so pasted/static copies go stale on
    # reboot. The client reads this file at startup (see '@' arg form).
    try:
        (KEYFILE.parent / "iroh-ticket.txt").write_text(ticket, encoding="utf-8")
    except OSError as e:
        print(f"ticket file write failed: {e}", flush=True)
    # Stable identity: persist the endpoint id next to the secret key —
    # clients pair by id once; tickets are disposable dial hints around it.
    try:
        (KEYFILE.parent / "iroh-endpoint-id.txt").write_text(str(ep.id()), encoding="utf-8")
    except OSError:
        pass

    def write_ticket(addr):
        (KEYFILE.parent / "iroh-ticket.txt").write_text(
            str(iroh.EndpointTicket.from_addr(addr)))

    async def announce():
        # Tickets embed relay hints that go stale across binds — rewrite a
        # fresh one whenever the endpoint's addresses change so any surface
        # serving this file (CLI, API, portal) always hands out a live one.
        try:
            ep.watch_addr(write_ticket)
            write_ticket(ep.addr())
        except Exception as e:
            print(f"ticket announce stopped: {e}", flush=True)

    await announce()
    print(f"bridging iroh -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
    while True:
        incoming = await ep.accept_next()
        if incoming is None:
            print("endpoint closed; exiting", flush=True)
            break
        try:
            acc = await incoming.accept()
            conn = await acc.connect()
        except iroh_ffi.IrohError as e:
            print(f"accept failed: {e}", flush=True)
            continue

        async def serve(conn=conn):
            while True:
                try:
                    stream = await conn.accept_bi()
                except iroh_ffi.IrohError as e:
                    # Normal end of a connection's stream intake (peer closed
                    # or timed out) — must not escape as an unretrieved task
                    # exception, or every disconnect spams the journal.
                    print(f"connection closed: {e}", flush=True)
                    return
                asyncio.create_task(pipe_stream(stream))

        asyncio.create_task(serve())


if __name__ == "__main__":
    asyncio.run(main())
