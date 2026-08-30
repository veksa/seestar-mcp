# First run against a real Seestar

Everything in this project has been developed against a fake and against the ASCOM simulators. This
is the list to work through the first time a real telescope is on the other end — outside, with the
scope in front of you, ready to stop it by hand.

Do it in daylight up to step 6 if you can: the mount moves, and you want to see it move.

## Before you start

- [ ] `seestar_alp` is running and its web UI answers on `http://<host>:5432`
- [ ] The Seestar is powered, awake, and connected to the same network
- [ ] The telescope has line of sight to the sky, and nothing within its swing radius
- [ ] Battery above 50% and at least a few GB free — check both in step 3

Start the server pointed at the driver:

```sh
npx -y seestar-mcp --host <host> --device 1
```

## 1. Discovery and connection

- [ ] `alpaca_discover` finds the driver, and the port matches `seestar_alp`'s config (5555 by default)
- [ ] The device list shows device **1** for the scope (device 0 is the federation — do not use it)
- [ ] `device_connect` succeeds and reports `is_seestar: true`
- [ ] `device_info` shows a plausible driver name and version

If discovery finds nothing but `device_connect` works, that is a network/broadcast issue, not a
driver one — worth noting in an issue.

## 2. Read-only pass

Nothing here moves the telescope. Run it all before anything that does.

- [ ] `telescope_status` reports coordinates, and they are not obviously wrong for your sky
- [ ] `seestar_state` shows battery, firmware and free storage
- [ ] `seestar_events` returns something (probably little before startup)
- [ ] `seestar_settings` shows exposure and gain

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
