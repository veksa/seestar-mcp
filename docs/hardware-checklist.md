# First run against a real Seestar

This project was developed against fakes and the ASCOM simulators. This is the list to work through
the first time a real telescope is on the other end — outside, with the scope in front of you, ready
to stop it by hand. Part A has been worked through on a Seestar S50 Pro, firmware 9.75, and the
built-in server path has since been used for several observing nights; Part B (`seestar_alp`) has
not been tried on real hardware.

Do it in daylight up to step 6 if you can: the mount moves, and you want to see it move.

## Part A — the built-in Alpaca server

Current firmware serves Alpaca from the telescope itself. The test stand (`yarn test:zwo`) runs
ZWO's own server, so what is unproven here is the firmware underneath it.

- [x] The Seestar is powered, awake and on the same network; note its IP address. The address can
      change after a power cycle; `alpaca_discover` finds the new one
- [x] `alpaca_discover` finds it on port **32323**, listing camera, focuser, filter wheel, telescope
      and switch — all device **0** (on the S50 Pro the wide-angle camera and focuser are device
      **1**)
- [ ] If the server's settings page has "Require Authorization" on, `device_connect` without
      `--password` says so; with `--password` it connects
- [x] `device_connect` (no arguments) reports `driver_kind: builtin`
- [x] `telescope_status` reports coordinates that are not obviously wrong for your sky. With the
      arm closed it reports altitude −89.8°, `at_home: yes` and `parked: no`
- [x] `telescope_set_tracking` on/off is reflected in `telescope_status`: with tracking on, RA
      and Dec hold while the azimuth drifts west; off, the azimuth holds while RA climbs
- [x] **With the arm closed**, `telescope_goto` to a target well above the horizon: does the arm
      unfold, or does the goto fail with "fail to operate"? The server's `Unpark` only clears a flag,
      so this decides how a session has to start. **Result (S50 Pro, firmware 9.75):**
      the arm unfolds and the goto completes with no unpark first; the server turns tracking on by
      itself when the slew ends
- [x] `telescope_abort` mid-slew stops the mount. The server turns tracking on afterwards, as it
      does at the end of a goto
- [x] `telescope_park` closes the arm; `telescope_status` reports `parked: yes` afterwards. It takes
      about 20 s. Unlike an arm closed at power-on, a parked arm reports `parked: yes`
- [x] Focuser: `alpaca_put` `connected` on `device_type: "focuser"`, then `alpaca_get_property`
      `position` gives a plausible number. On the S50 Pro the telephoto focuser (device 0) read
      1140 of 2600 steps with a temperature, the wide-angle one (device 1) 320 of 1023 with
      temperature 0; neither implements `stepsize`
- [x] Filter wheel: `alpaca_put` `position` on `device_type: "filterwheel"` moves the wheel (listen).
      Names are `Dark`, `IR`, `LP` (positions 0–2); `position` reads -1 while the wheel turns
- [x] `camera_capture` saves a FITS frame and returns a preview. A 2160×3840 frame (16.6 MB as
      ImageBytes) takes 10–20 s to download over Wi-Fi; the exposure, FITS, preview and ASTAP solve
      add well under a second. A blown star reads 65520, not 65535
- [x] `camera_capture` with `solve: true` solves a 3 s frame of M45 with ASTAP and the D05
      catalogue; the telephoto field is 1.35° × 2.39°
- [x] `telescope_center` on M45 ends within 0.7′ of the target; the camera is left disconnected
      with its gain restored. The first manual round of the same loop took a 3.8° error to 5′
- [x] `telescope_center` after a power cycle, when the mount's model is degrees off: how many
      attempts does it need? With the azimuth 20–74° off, the main camera's frame did not solve at
      all. A wide-angle frame (`camera: 1`) solved with ASTAP's W08 database and a `telescope_sync`
      came first; `telescope_center` then needed one correction
- [x] On real nights `telescope_center` typically missed by 10–40′ on the first frame and ended
      within 1.5′ after one sync. Once, right after a long slew, an attempt solved a frame still
      showing the previous target and synced on it; a second `telescope_center` with the mount at
      rest corrected the model
- [ ] `seestar_state` refuses with directions rather than an "action not implemented" error
- [ ] With the server and the Seestar app both connected, the app still controls the scope — it is
      the way out if the Alpaca server stops answering (see "If the built-in server stops
      answering" in the README)
- [x] If any request hangs: note the tool and arguments, then confirm that a power cycle brings the
      Alpaca server back. It does, possibly at a new IP address

## Part B — `seestar_alp`

The rest of this list is for the `seestar_alp` path, which the `seestar_*`, `imaging_*` and
`schedule_*` tools need. Whether `seestar_alp` can reach current firmware at all is itself the first
thing to find out.

> **Verified 2026-11-15 on a Seestar S50 Pro, firmware 9.75, seestar_alp v3.3.1.** Sections 1 and 2
> (discovery, connection, read-only pass) pass. Firmware 7.18+ needs the client interop PEM key
> (extracted from the Seestar APK); with it set in `config.toml` the alp log prints
> `Authentication successful` and all reads work. Sections 3–9 (startup, movement, imaging,
> scheduler) still await a clear night.
>
> **The telescope's IP changes** (DHCP, and after a power cycle). Always run `alpaca_discover` first
> and point both the MCP `--host` and `seestar_alp`'s `config.toml` at the address it reports — a
> stale IP shows up as `connect socket error: timed out` with an empty UDP scan, which is not an auth
> problem. The subnet itself can change between sessions, not just the host part.

## Before you start

- [x] `seestar_alp` is running and its web UI answers on `http://<host>:<uiport>` (set in `config.toml`; defaults to 5432)
- [x] The Seestar is powered, awake, and connected to the same network
- [ ] The telescope has line of sight to the sky, and nothing within its swing radius
- [x] Battery above 50% and at least a few GB free — check both in step 3 (91%, 106 GB)

Start the server pointed at the driver (port is `seestar_alp`'s Alpaca port from `config.toml`, not
necessarily 5555):

```sh
npx -y seestar-mcp --host <host> --port <alp alpaca port> --device 1
```

## 1. Discovery and connection

- [x] `alpaca_discover` finds the driver, and the port matches `seestar_alp`'s config (5555 by default)
- [x] The device list shows device **1** for the scope (device 0 is the federation — do not use it)
- [x] `device_connect` succeeds and reports `is_seestar: true`
- [x] `device_info` shows a plausible driver name and version

If discovery finds nothing but `device_connect` works, that is a network/broadcast issue, not a
driver one — worth noting in an issue.

## 2. Read-only pass

Nothing here moves the telescope. Run it all before anything that does.

- [x] `telescope_status` reports coordinates, and they are not obviously wrong for your sky
- [x] `seestar_state` shows battery, firmware and free storage
- [x] `seestar_events` returns something (probably little before startup)
- [x] `seestar_settings` shows exposure and gain

> One quirk: fire alp requests one at a time. Several Alpaca calls at once can reset a connection
> (`ECONNRESET`); sequential calls are fine.

## 3. Startup sequence

- [ ] `seestar_startup` with your latitude and longitude
- [ ] The arm actually unfolds and the mount levels itself
- [ ] `seestar_events` shows `Initialise` going `working` → `complete`
- [ ] `telescope_status` afterwards reports `parked: no`

## 4. Movement — watch the telescope, not the screen

- [ ] `telescope_goto` to a target well above the horizon; the mount starts moving
- [ ] `telescope_abort` mid-slew actually stops it
- [ ] `telescope_status` reports `slewing: no` afterwards

## 5. Plate-solved goto

- [ ] `seestar_goto_target` on a bright object (e.g. M42, M31, or the Moon)
- [ ] `seestar_events` shows `AutoGoto` progressing and then `complete`
- [ ] The object is actually centred — this is the difference between this tool and `telescope_goto`

## 6. Focus and accessories

- [ ] `seestar_autofocus` with `operation: "start"`, then watch the `AutoFocus` event
- [ ] `seestar_filter_wheel` moves the wheel (listen for it)
- [ ] `seestar_dew_heater` at 50 warms the lens ring; set it back to 0 afterwards

## 7. Imaging — after dark

- [ ] `imaging_start` on a target for a few minutes
- [ ] `seestar_events` shows `Stack` with a rising frame count
- [ ] `imaging_last_image` returns a URL that opens in a browser on your network
- [ ] `imaging_stop` ends the session

Then confirm the driver's refusal behaviour:

- [ ] Starting a second `imaging_start` while one is running reports "a session is already running"

## 8. Scheduler

- [ ] `schedule_create`, then a couple of `schedule_add_item` calls (`wait_for` 60s, then a short
      `start_mosaic`)
- [ ] `schedule_get` lists them with ids
- [ ] `schedule_control` with `start` runs them in order; `▶` marks the current one
- [ ] `schedule_control` with `stop` ends it

## 9. Ending the night

- [ ] `telescope_park` — the arm closes; `telescope_status` reports `parked: yes` after a while
      (parking is asynchronous)
- [ ] Optionally `seestar_power` with `--allow-destructive` and `confirm: true`, and confirm the
      telescope needs its button afterwards

## What to write down

For anything that behaves differently from the tool descriptions, note:

- the tool and arguments used
- what the telescope did
- what `seestar_events` said at the time
- the `seestar_alp` log line, if there is one

Response shapes in particular are worth reporting: the fake in `test/fake/` was built from the
`seestar_alp` sources, and any real response that does not match belongs there as a fix.
