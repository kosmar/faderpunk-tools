# faderpunk-tools

Personal companion webapps for [Faderpunk](https://github.com/ATOVproject/faderpunk).
These are **not** part of the upstream ATOV repo and will not be proposed as PRs there.

**Live (GitHub Pages):** https://kosmar.github.io/faderpunk-tools/

| App | Folder | URL |
| --- | --- | --- |
| **Presetpunk** | `presetpunk/` | https://kosmar.github.io/faderpunk-tools/presetpunk/ |
| **Scopepunk** | `scopepunk/` | https://kosmar.github.io/faderpunk-tools/scopepunk/ |

Also mirrored on feature branches of the fork [kosmar/faderpunk](https://github.com/kosmar/faderpunk) (`add-preset-editor`, `feat/midi-diagnostics`).

Use Chromium with Web MIDI + SysEx. Close other tabs that hold the Faderpunk ports.

## Presetpunk (local)

```bash
cd presetpunk
node server.mjs   # http://127.0.0.1:3847/ — optional Node API for bank file + MIDI CSV cache
```

On GitHub Pages the same UI runs fully static (bank in `localStorage`, MIDI CC catalog via GitHub/jsDelivr).

## Scopepunk (local)

```bash
cd scopepunk
pnpm install
pnpm dev
```
