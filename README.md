# faderpunk-tools

Personal companion webapps for [Faderpunk](https://github.com/ATOVproject/faderpunk).
These are **not** part of the upstream ATOV repo and will not be proposed as PRs there.

| App | Folder | What it does |
| --- | --- | --- |
| **Presetpunk** | `presetpunk/` | Preset-bank editor (layouts, params, MIDI routing) |
| **Scopepunk** | `scopepunk/` | Live MIDI scopes, waveform profiles, audible monitor |

Also mirrored on feature branches of the fork [kosmar/faderpunk](https://github.com/kosmar/faderpunk) (`add-preset-editor`, `feat/midi-diagnostics`).

## Presetpunk

```bash
cd presetpunk
# Node server, no build step
node server.mjs
```

## Scopepunk

```bash
cd scopepunk
pnpm install
pnpm dev
```

Needs a Chromium browser with Web MIDI + SysEx and a live Faderpunk.
