# seestar-mcp

[![npm version](https://img.shields.io/npm/v/seestar-mcp.svg)](https://www.npmjs.com/package/seestar-mcp)
[![npm downloads](https://img.shields.io/npm/dm/seestar-mcp.svg)](https://www.npmjs.com/package/seestar-mcp)
[![CI](https://github.com/veksa/seestar-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/veksa/seestar-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/seestar-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP server for ZWO Seestar telescopes (S50, S50 Pro, S30, S30 Pro) over [ASCOM Alpaca](https://ascom-standards.org/).

Point your telescope at a target, image it, then stack and process what it captured — from Claude
Code, Claude Desktop, or any other MCP host.

Two servers ship in this package:

- **`seestar-mcp`** drives the telescope: find it, point it, image, download the frames.
- **`astro-mcp`** processes the frames with [Siril](https://siril.org) and GraXpert: align, stack,
  flatten the background, denoise, stretch, export.

```
you → Claude ─┬→ seestar-mcp ─→ Seestar (built-in Alpaca server)
              │       MCP     └→ seestar_alp → Seestar     (optional, for the seestar_* tools)
              └→ astro-mcp   → Siril, GraXpert → PNG
```

They meet at a directory of files, not in code, so you can run either on its own. The processing
side is documented in [`docs/processing.md`](docs/processing.md).

Current Seestar firmware runs an Alpaca server on the telescope itself (port `32323`). That is all
this server needs for the standard ASCOM devices: the mount, the camera, the focuser and the filter
wheel. It is the default. It also lists a switch, but on firmware 9.75 that switch calls itself
"Alpaca Switch Simulator", so do not expect it to control the dew heater.

On top of the built-in server this package does the plate solving itself: `telescope_center` slews,
takes a frame with the Alpaca camera, solves it with [ASTAP](https://hnsky.org/astap.htm) and
corrects until the target is centred, and `camera_capture` saves frames as FITS. See
[Frames and plate solving](#frames-and-plate-solving).

The remaining Seestar-specific tools — the telescope's own stacking, mosaics, the scheduler,
downloads — need [`seestar_alp`](https://github.com/smart-underworld/seestar_alp), a community driver that speaks the
telescope's own protocol. It runs anywhere on your network (default port `5555`). Whether it can
still reach the newest firmware has not been checked.

The Alpaca core is generic, so the standard telescope tools also work against any other Alpaca
device — including the [ASCOM simulators](https://github.com/ASCOMInitiative/ASCOM.Alpaca.Simulators),
which is how you can try this without a telescope.

> **Status: early development.** The tools work and are tested — against ZWO's own built-in Alpaca
> server running on a fake firmware, against the ASCOM simulators, and against a fake of
> `seestar_alp`. Against a real telescope (S50 Pro, firmware 9.75) only the built-in server path has
> been tried so far — see [`docs/hardware-checklist.md`](docs/hardware-checklist.md). Expect rough
> edges under the stars.

## Requirements

- Node.js 20 or newer
- A Seestar on current firmware, on the same network as this machine — or a running `seestar_alp`,
  or any other ASCOM Alpaca device for the generic tools
- For `telescope_center`: the [ASTAP](https://hnsky.org/astap.htm) command-line solver and a star
  database (D05 for a Seestar)

## Turn on the telescope's Alpaca server

The built-in server ships with firmware 9.75 and app 3.4.1, and it is **off by default**.

1. Put the Seestar on your home Wi-Fi with the app's Station Mode, the same network as this
   machine. The telescope's own hotspot works too (the address is then `10.0.0.1`), but the computer
   loses its internet connection while it is joined to it.
2. Unplug the USB cable. While the Seestar is mounted as a drive, it does not answer on the network.
3. In the app, connect to the telescope and open **Advanced Feature → Assistive Features**. Turn on
   **Seestar Alpaca**.
4. Wait a minute or two: the server starts some time after the switch is flipped.
5. Check that it answers:

   ```sh
   curl "http://<telescope address>:32323/management/v1/configureddevices"
   ```

   The reply lists the telescope, cameras, focusers, filter wheel and switch. The app has no password
   setting for this server, so it accepts requests from anyone on the network.

## Install

Claude Code:

```sh
claude mcp add seestar -- npx -y seestar-mcp --host <telescope address>
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "seestar": {
      "command": "npx",
      "args": ["-y", "seestar-mcp", "--host", "<telescope address>"]
    }
  }
}
```

Replace `<telescope address>` with the telescope's IP address. Don't know it? Leave `--host` out and
ask the model to run `alpaca_discover` — it will broadcast on the local network and list what
answers.

To go through `seestar_alp` instead, point `--host` at the machine running it and add
`--port 5555 --device 1`.

## Options

Every option can be given as a flag or an environment variable.

| Flag | Environment | Default | What it does |
|---|---|---|---|
| `--host <address>` | `SEESTAR_HOST` | — | Address of the Alpaca server |
| `--port <number>` | `SEESTAR_PORT` | `32323` | Alpaca port; `seestar_alp` uses `5555` |
| `--device <number>` | `SEESTAR_DEVICE` | `0` | Device number — see the warning below |
| `--device-type <type>` | `SEESTAR_DEVICE_TYPE` | `telescope` | Any Alpaca device type |
| `--timeout <ms>` | `SEESTAR_TIMEOUT_MS` | `10000` | Per-request timeout |
| `--profile <name>` | `SEESTAR_PROFILE` | `auto` | `auto`, `seestar`, or `generic` |
| `--read-only` | `SEESTAR_READ_ONLY` | off | Register only tools that cannot move the telescope |
| `--allow-destructive` | `SEESTAR_ALLOW_DESTRUCTIVE` | off | Allow shutdown and reboot |
| `--no-raw` | `SEESTAR_ALLOW_RAW=0` | raw on | Hide the raw firmware passthrough |
| `--client-id <number>` | `SEESTAR_CLIENT_ID` | random | Fixed Alpaca ClientID |
| `--username <name>` | `SEESTAR_USERNAME` | `User` | User for a password-protected server |
| `--password <secret>` | `SEESTAR_PASSWORD` | — | Password, if the server has "Require Authorization" on |
| `--capture-dir <path>` | `SEESTAR_CAPTURE_DIR` | `<work dir>/captures` | Where `camera_capture` and `telescope_center` save frames |
| `--astap <path>` | `ASTAP_PATH` | searched | The ASTAP plate solver (`astap_cli`) |
| `--astap-db <path>` | `ASTAP_DATABASE` | next to the binary | ASTAP star database directory |
| `--astap-catalog <name>` | `ASTAP_CATALOG` | ASTAP decides | ASTAP catalogue, e.g. `d05` |

> **Device numbers depend on the driver.** The built-in server numbers every device `0`, except
> on the S50 Pro: its wide-angle camera and focuser are device `1`. On
> `seestar_alp`, device `0` is the "federation" — a command sent to it goes to *every* telescope it
> manages — and your first scope is device `1`. `device_connect` warns if it finds itself on the
> federation.

`--profile auto` works out which driver it is talking to when you connect: the built-in server,
`seestar_alp`, or some other Alpaca device. The `seestar_*`, `imaging_*` and `schedule_*` tools run
only on `seestar_alp`; elsewhere they say what to use instead. Force the choice with `seestar` or
`generic` if the guess is wrong.

## Tools

**Finding and connecting** — work with any Alpaca server

`alpaca_discover` · `alpaca_devices` · `device_connect` · `device_info`

**Mount** — standard ASCOM, works with any Alpaca telescope

`telescope_status` · `telescope_goto` · `telescope_sync` · `telescope_abort` · `telescope_park` ·
`telescope_unpark` · `telescope_find_home` · `telescope_set_tracking` · `telescope_action`

**Camera and plate solving** — any Alpaca camera; centring needs ASTAP

`camera_capture` (FITS + preview, optional solve) · `telescope_center` (plate-solved goto)

**Any other device** — focuser, filter wheel, dome, switch…

`alpaca_get_property` · `alpaca_put`

**Seestar** — need `seestar_alp`

`seestar_state` (battery, storage, firmware) · `seestar_events` (progress of everything slow) ·
`seestar_view_state` · `seestar_settings` · `seestar_set_settings` · `seestar_startup` ·
`seestar_goto_target` (plate-solved, centred) · `seestar_stop_goto` · `seestar_autofocus` ·
`seestar_filter_wheel` · `seestar_dew_heater` · `seestar_raw` · `seestar_power`

**Imaging** — need `seestar_alp`

`imaging_start` (single target or mosaic) · `imaging_start_stack` · `imaging_stop` ·
`imaging_solve` · `imaging_last_image`

**Scheduler** — plan a night and let the telescope run it; needs `seestar_alp`

`schedule_get` · `schedule_create` · `schedule_add_item` · `schedule_remove_item` ·
`schedule_control`

**Files** — get what was captured onto this computer; needs `seestar_alp`

`imaging_albums` · `imaging_download`

**Processing** (the `astro-mcp` server)

`astro_tools` · `session_list` · `astro_inspect` · `process_session` · `astro_stack` ·
`astro_background_extract` · `astro_denoise` · `astro_deconvolve` · `astro_color_calibrate` ·
`astro_stretch` · `astro_remove_stars` · `astro_export` · `astro_run_script` · `astro_job`

### A session through `seestar_alp`, roughly

1. `seestar_startup` — unfold and calibrate; watch the `Initialise` event
2. `seestar_state` — is there enough battery and disk for the night?
3. `seestar_goto_target` — plate-solved goto, so the object is actually centred
4. `imaging_start` — stack for as long as you like, or capture a mosaic
5. `seestar_events` — how many frames have stacked, what stage the scope is in
6. `imaging_last_image` — a URL to the latest frame, served by the telescope
7. `telescope_park` — close the arm

Anything slow reports progress through `seestar_events` rather than blocking. `seestar_goto_target`
and `seestar_startup` also take `wait: true` when you would rather have one answer than poll.

Then, once the frames are on your computer (`imaging_download`), hand them to the other server:

```
process_session { session: "M31", preset: "standard", output: "m31.png" }
```

See [`docs/processing.md`](docs/processing.md) for the presets, the individual steps, and what has
to be installed for each.

## Safety

- `--read-only` registers only the tools that cannot move anything — the model never sees the rest.
- `seestar_power` (shutdown, reboot) needs both `--allow-destructive` at startup **and**
  `confirm: true` in the call. A telescope that has been shut down cannot be woken remotely.
- `seestar_raw` and `alpaca_put` have no guard rails by design. `--no-raw` hides the firmware one.
- Before anything that moves the telescope, the server reads its slewing state with a short
  timeout. If that read does not come back, nothing is sent, and the tool says what to do instead.
  `telescope_abort` is never held back.

### If the built-in server stops answering

The Seestar's built-in Alpaca server has a weak spot, reproduced on the test stand: a single reply
from the firmware in a shape it does not expect ends its link to the firmware. From then on every
request that needs the firmware — position, slewing, abort, park — waits forever, while the
server still answers some things from memory. `telescope_status` flags this, and movements are
refused.

The telescope itself is not at risk. A goto stops at its target, and a manual axis move is
re-requested every second for three seconds at a time, so it stops on its own once the requests
stop. To recover:

1. Stop or park with the Seestar app — it talks to the firmware directly, not through Alpaca.
2. Switch the telescope off and on again. That restarts its Alpaca server; reconnecting is not
   enough.
3. Run `device_connect` again.

On the built-in server, reach the camera, focuser and filter wheel with `alpaca_get_property` and
`alpaca_put` (`device_type: "focuser"` and so on, device `0`; on the S50 Pro the wide-angle camera
and focuser are device `1`). Select the device with `device_connect` first: a camera answers almost
nothing until it is connected.

Right after power-on the built-in server does not count the closed arm as parked, so the first
`telescope_goto` needs no unpark: it unfolds the arm and slews. After `telescope_park` the server
does report the telescope as parked, so run `telescope_unpark` before the next goto. Tracking turns
on by itself when a goto ends or is aborted.

## Frames and plate solving

The built-in server has no plate solving of its own, and a plain `telescope_goto` lands wherever
the mount's model says the target is. Right after power-on, or after the telescope has been moved,
that was 3.8° off on the first real test — wider than the whole field. `telescope_center` fixes it:

1. slew to the target (J2000, as in catalogues; converted to the mount's equinox of date),
2. take a short frame with the main camera,
3. solve it with ASTAP,
4. if the target is further from the centre than `tolerance_arcmin` (default 2′), sync the mount to
   where it really points and slew again.

On the real telescope one correction took the error from 3.8° to 5′.

Install the ASTAP command-line solver and one star database — D05 suits the Seestar's 1.3° × 2.4°
field — from [hnsky.org](https://hnsky.org/astap.htm), and pass `--astap` (and `--astap-db` if the
database is not next to the binary).

Frames are saved as 16-bit FITS with the Bayer pattern, exposure, gain and the mount position in
the header:

```
<capture dir>/<night>/<target>/<target>_<exposure>s_g<gain>_<HHMMSS>.fits
<capture dir>/<night>/<target>/center/…        the frames telescope_center took
```

`<night>` is the local date the evening started on, so a frame from 01:30 sits with the ones from
23:00. Both tools return a stretched preview, so the model can see clouds, a wall or a balcony roof
for itself. `camera: 1` uses the S50 Pro's wide-angle camera.

The camera is left the way it was found: a gain set for one frame is put back, and a camera that
had to be connected is disconnected again, so the Seestar app sees no difference.

## Without a telescope

```sh
yarn sim:fetch                                    # downloads the ASCOM simulators
.cache/omnisim/*/ascom.alpaca.simulators --urls=http://127.0.0.1:32323
npx -y seestar-mcp --host 127.0.0.1 --port 32323 --device 0 --profile generic
```

The simulators cover telescope, camera, focuser, filter wheel and more, so the standard tools all
work. The Seestar-specific ones do not — nothing but a Seestar implements them.

## Development

```sh
yarn install
yarn test          # unit + integration against the built-in fakes
yarn test:sim      # downloads the ASCOM simulators and tests against them
yarn test:siril    # downloads Siril and runs the processing pipeline for real
yarn test:zwo      # runs the tools against the Seestar's built-in Alpaca server, in Docker
yarn typecheck
yarn lint
```

No telescope and no simulator are needed for the first suite: `test/fake/` implements an Alpaca
server with Seestar semantics in-process — a mount that takes time to slew, the firmware event
stream, the scheduler, and injectable failures.

The second suite runs the same client against the
[ASCOM Alpaca Simulators](https://github.com/ASCOMInitiative/ASCOM.Alpaca.Simulators), the reference
implementation of the specification. The binaries are self-contained (no .NET runtime needed) and
are cached in `.cache/`.

The third suite runs ZWO's own Alpaca server in a container, with only the firmware under it faked
(`test/zwo/firmware.mjs`). The server is closed source and not part of this repository: it needs
Docker and a copy of the telescope's `/etc/zwo/Alpaca`, in `.cache/seestar-alpaca` or wherever
`SEESTAR_ALPACA_DIR` points. Without them the suite skips.

Before pointing this at real hardware, work through [`docs/hardware-checklist.md`](docs/hardware-checklist.md).

## License

MIT
