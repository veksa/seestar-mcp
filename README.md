# seestar-mcp

MCP server for ZWO Seestar telescopes (S50 / S50 Pro / S30) over [ASCOM Alpaca](https://ascom-standards.org/).

Talk to your telescope from Claude Code, Claude Desktop, or any other MCP host:
point it at a target, start a stack, check the battery, run a schedule.

> **Status: early development.** The tool surface is still moving. See the milestones below.

## How it fits together

```
Claude Code / Claude Desktop
    | MCP (stdio)
seestar-mcp
    | HTTP (ASCOM Alpaca)
seestar_alp
    | TCP JSON-RPC
Seestar S50 Pro
```

[`seestar_alp`](https://github.com/smart-underworld/seestar_alp) is the Alpaca driver that speaks the
telescope's native protocol. It runs anywhere on your network — this server only needs HTTP access to
it (default port `5555`).

The Alpaca core is generic, so the standard telescope and camera tools also work against any other
Alpaca device, including the [ASCOM simulators](https://github.com/ASCOMInitiative/ASCOM.Alpaca.Simulators).

## Requirements

- Node.js 20 or newer
- A running `seestar_alp` instance (or any ASCOM Alpaca device for the generic tools)

## Install

```sh
claude mcp add seestar -- npx -y seestar-mcp --host 127.0.0.1
```

## Development

```sh
yarn install
yarn test          # unit + integration against the built-in fake Alpaca server
yarn typecheck
yarn lint
```

No telescope and no simulator are needed for that suite: `test/fake/` implements an Alpaca server
with Seestar semantics in-process — including a mount that takes time to slew, the firmware event
stream, and injectable failures.

```sh
yarn test:sim      # downloads the ASCOM simulators and tests against them
```

That second suite runs the same client against the [ASCOM Alpaca
Simulators](https://github.com/ASCOMInitiative/ASCOM.Alpaca.Simulators), the reference
implementation of the specification. The binaries are self-contained (no .NET runtime needed) and
are cached in `.cache/`.

## License

MIT
