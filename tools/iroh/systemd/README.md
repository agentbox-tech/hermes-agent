# systemd deployment for the iroh bridge

Reference drop-in for deploying `tools/iroh/iroh_bridge_server.py` as a
systemd (user) unit or podman quadlet.

## Why a scheduling priority drop-in

The bridge is a realtime proxy: it terminates an iroh/QUIC connection and
pipes it to a local TCP port. Sustained cost is trivial (measured on a
Pixel 3 / sdm845: ~1.7% of one core and ~34 MB per bridge), but its work
is *when-heavy*: keepalive and WS traffic must be scheduled promptly. On
hosts that also run bursty workloads (test suites, builds, container
sandboxes, git pack windows, boot-time swap churn), a default-weight
scheduler can starve the bridge for long enough to drop sessions —
observed as silent `connection closed` bursts in the bridge log with no
crash and no error anywhere else.

`CPUWeight=1000` makes the bridge win the core whenever the box is
saturated, costs nothing at idle, and — unlike `Nice=-10` — requires no
privilege, so it works in rootless user units and quadlets.

## Install

```sh
# native service
mkdir -p ~/.config/systemd/user/hermes-iroh-bridge.service.d
cp 10-realtime.conf ~/.config/systemd/user/hermes-iroh-bridge.service.d/
systemctl --user daemon-reload

# quadlet: add the same keys under [Service] of the .container file
#   (memory keys belong in [Service], not [Container] — quadlet rejects them there)
```

## Deliberately NOT included

- `Nice=-10` — requires `CAP_SYS_NICE`; fails in rootless user managers.
- `MemoryMin` / `MemoryHigh` — cgroup controller delegation varies by
  distro/slice; tune per box, not upstream.
