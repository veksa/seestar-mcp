# seestar-mcp

MCP server for ZWO Seestar telescopes (S50 / S50 Pro / S30) over [ASCOM Alpaca](https://ascom-standards.org/).

Point your telescope at a target, image it, then stack and process what it captured — from Claude
Code, Claude Desktop, or any other MCP host.

Two servers ship in this package:

- **`seestar-mcp`** drives the telescope: find it, point it, image, download the frames.
- **`astro-mcp`** processes the frames with [Siril](https://siril.org) and GraXpert: align, stack,
  flatten the background, denoise, stretch, export.

```
you → Claude ─┬→ seestar-mcp → seestar_alp → Seestar
              │       MCP        Alpaca/HTTP    TCP
              └→ astro-mcp   → Siril, GraXpert → PNG
```

They meet at a directory of files, not in code, so you can run either on its own. The processing
side is documented in [`docs/processing.md`](docs/processing.md).

[`seestar_alp`](https://github.com/smart-underworld/seestar_alp) is the driver that speaks the
telescope's own protocol. It can run anywhere on your network; this server only needs HTTP access to
it (default port `5555`).

The Alpaca core is generic, so the standard telescope tools also work against any other Alpaca
device — including the [ASCOM simulators](https://github.com/ASCOMInitiative/ASCOM.Alpaca.Simulators),
which is how you can try this without a telescope.

> **Status: early development.** The tools work and are tested, but nothing here has been run
> against real hardware yet. Expect rough edges under the stars.

## Requirements

- Node.js 20 or newer
- A running `seestar_alp` instance (or any ASCOM Alpaca device, for the generic tools)

## Install

Claude Code:

```sh
claude mcp add seestar -- npx -y seestar-mcp --host seestar.local
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "seestar": {
      "command": "npx",
      "args": ["-y", "seestar-mcp", "--host", "seestar.local"]
    }
  }
}
```

Replace `seestar.local` with the address of the machine running `seestar_alp`. Don't know it? Leave
`--host` out and ask the model to run `alpaca_discover` — it will broadcast on the local network and
list what answers.

## Options

Every option can be given as a flag or an environment variable.

| Flag | Environment | Default | What it does |
|---|---|---|---|
| `--host <address>` | `SEESTAR_HOST` | — | Address of the Alpaca server |
| `--port <number>` | `SEESTAR_PORT` | `5555` | Alpaca port |
| `--device <number>` | `SEESTAR_DEVICE` | `1` | Device number — see the warning below |
| `--device-type <type>` | `SEESTAR_DEVICE_TYPE` | `telescope` | Any Alpaca device type |
| `--timeout <ms>` | `SEESTAR_TIMEOUT_MS` | `10000` | Per-request timeout |
| `--profile <name>` | `SEESTAR_PROFILE` | `auto` | `auto`, `seestar`, or `generic` |
| `--read-only` | `SEESTAR_READ_ONLY` | off | Register only tools that cannot move the telescope |
| `--allow-destructive` | `SEESTAR_ALLOW_DESTRUCTIVE` | off | Allow shutdown and reboot |
| `--no-raw` | `SEESTAR_ALLOW_RAW=0` | raw on | Hide the raw firmware passthrough |
| `--client-id <number>` | `SEESTAR_CLIENT_ID` | random | Fixed Alpaca ClientID |

> **Device numbers start at 1.** On `seestar_alp`, device `0` is the "federation" — a command sent
> to it goes to *every* telescope it manages. Your first scope is device `1`.

`--profile auto` decides whether the Seestar tools apply by looking at how the driver describes
itself when you connect. Force it with `seestar` or `generic` if the guess is wrong.

## Tools

**Finding and connecting** — work with any Alpaca server

`alpaca_discover` · `alpaca_devices` · `device_connect` · `device_info`

**Mount** — standard ASCOM, works with any Alpaca telescope

`telescope_status` · `telescope_goto` · `telescope_sync` · `telescope_abort` · `telescope_park` ·
`telescope_unpark` · `telescope_find_home` · `telescope_set_tracking` · `telescope_action`

**Any other device** — focuser, filter wheel, dome, switch…

`alpaca_get_property` · `alpaca_put`

**Seestar**

`seestar_state` (battery, storage, firmware) · `seestar_events` (progress of everything slow) ·
`seestar_view_state` · `seestar_settings` · `seestar_set_settings` · `seestar_startup` ·
`seestar_goto_target` (plate-solved, centred) · `seestar_stop_goto` · `seestar_autofocus` ·
`seestar_filter_wheel` · `seestar_dew_heater` · `seestar_raw` · `seestar_power`

**Imaging**

`imaging_start` (single target or mosaic) · `imaging_start_stack` · `imaging_stop` ·
`imaging_solve` · `imaging_last_image`

**Scheduler** — plan a night and let the telescope run it

`schedule_get` · `schedule_create` · `schedule_add_item` · `schedule_remove_item` ·
`schedule_control`

**Files** — get what was captured onto this computer

`imaging_albums` · `imaging_download`

**Processing** (the `astro-mcp` server)

`astro_tools` · `session_list` · `astro_inspect` · `process_session` · `astro_stack` ·
`astro_background_extract` · `astro_denoise` · `astro_deconvolve` · `astro_color_calibrate` ·
`astro_stretch` · `astro_remove_stars` · `astro_export` · `astro_run_script` · `astro_job`

### A session, roughly

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

Before pointing this at real hardware, work through [`docs/hardware-checklist.md`](docs/hardware-checklist.md).

## License

MIT
