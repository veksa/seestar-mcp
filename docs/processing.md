# Processing your frames

`astro-mcp` is the second server in this package. It takes the frames the telescope captured and
runs them through [Siril](https://siril.org) — align, stack, flatten the sky, denoise, stretch,
export — and it does that by writing Siril scripts, not by reimplementing any of it.

```sh
claude mcp add astro -- npx -y astro-mcp
```

Ask the model to run `astro_tools` first. It reports which programs it found, where, and what is
missing — the answer to almost every "why did that not work".

## What you need to install

| Program | Needed for | Cost |
|---|---|---|
| [Siril](https://siril.org/download/) 1.4+ | everything | free (GPL) |
| [GraXpert](https://github.com/Steffenhir/GraXpert) | the AI gradient removal and denoise | free |
| [StarNet](https://www.starnetastro.com/) or Siril's Zenith script | star removal | free |
| [RC Astro CLI](https://www.rc-astro.com/stand-alone-rc-astro-tools/) | BlurXTerminator and friends | paid |

Nothing is bundled. If a program is missing, the tools that need it say so and name the environment
variable that overrides the search (`SIRIL_PATH`, `GRAXPERT_PATH`, `STARNET_PATH`).

For development and CI there is a shortcut that installs nothing system-wide:

```sh
yarn siril:fetch     # portable Siril into .cache/, newest release
```

GraXpert inside Siril is a script rather than a separate program: install it once through Siril's
**Scripts → Get Scripts**. The same is true of Zenith (search for "SyQon") and of the RC Astro
tools.

## Where the files live

The two servers meet at a directory, not in code:

```
~/astro/                        --work-dir, or ASTRO_WORK_DIR
└── M31/
    ├── raw/                    what imaging_download fetched from the telescope
    ├── process/                the sequence, the stack, and every intermediate
    │   ├── stacked.fit
    │   ├── stacked_processed.fit
    │   └── m31.png
    └── logs/                   one log per job, exactly what Siril printed
```

Point both servers at the same `--work-dir` and the telescope side fills it while the processing
side reads it.

## A whole night in one call

```
process_session { session: "M31", preset: "standard", output: "m31.png" }
```

| Preset | What it does |
|---|---|
| `quick` | stack everything, stretch, export |
| `standard` | drop the worst 10% of frames, stack, flatten the sky with Siril, calibrate colour, stretch |
| `full` | as standard, plus GraXpert denoise and deconvolution |

Every step can be overridden — `background: "graxpert"`, `denoise: "none"`, `remove_stars: true` —
and the tool prints the Siril script it is about to run before it runs it.

It returns a job id. A real session of two hundred frames takes minutes, so follow it with
`astro_job` rather than waiting.

## Or step by step

When you want control, the same work is available one stage at a time. Each reads a file and writes
a new one, so you can stop and look after any of them:

`astro_stack` → `astro_background_extract` → `astro_denoise` → `astro_deconvolve` →
`astro_color_calibrate` → `astro_stretch` → `astro_remove_stars` → `astro_export`

`astro_run_script` takes raw Siril commands for anything not covered — including Zenith, which is a
Siril script:

```
astro_run_script { session: "M31", commands: ["load stacked", "pyscript SyQon-Starless.py", "save starless"] }
```

## Things worth knowing

**Colour calibration needs a plate solve.** `pcc` and `spcc` match stars against a catalogue, so the
image must be solved first — the tool does that for you, but it needs the field to be real sky and,
usually, an internet connection.

**Stretching is not optional.** Stacked data is linear: opened as-is it looks like a black
rectangle. Every export stretches by default; turn it off only if you stretched already.

**Star removal is last.** It works on stretched data, and gives you a starless image plus a star
layer to recombine.

**Sub-frames are demosaiced for you.** A Seestar sub-frame is raw one-shot-colour data — a single
plane carrying a Bayer mosaic, which `astro_inspect` reports as `one-shot colour, Bayer GRBG`.
Stacking it as it stands would give a grey image with the mosaic baked in, so the tools read the
BAYERPAT card and demosaic. Override with `debayer: true` or `debayer: false` if the header lies.

**Mixed exposures stack badly.** `astro_inspect` says when a session contains more than one exposure
length, which usually means it should be split and stacked separately.

**The Seestar only saves individual frames if you tell it to.** In the app: Advanced Settings →
"Save each frame in enhancing". Without it there is nothing to stack — just the JPEG the telescope
made itself.

## When something fails

Every job writes a log next to the session, and `astro_job` shows the tail of it:

```
astro_job { id: "job-3", log_lines: 50 }
```

Siril's own error line — `Error in line 7 ('pcc'): ...` — is what the tool reports back, so the
message you see is the message Siril gave.
