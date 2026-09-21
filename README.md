# Deborah Remote

An Obsidian plugin (mobile + desktop) that does two things over the tailnet:

1. **Native stream view** — renders the live Claude-session prose from the
   [`todaystream`](../../services/todaystream) service inside an Obsidian pane,
   with a type-back box. Uses Obsidian's own markdown renderer, so it matches
   your theme (no iframe, no mobile CSP quirks).
2. **Remote-control channel** — holds an SSE connection to `todaystream`'s
   `/cmd/stream` and executes commands pushed from d2: open notes, flip Reading
   mode, run any command, edit the vault. Acks results back.

## Security

Tailnet-only, bearer-gated. **The bearer is a root key** — the command channel
can create/modify/delete notes and run arbitrary JS (`eval`) with full vault
access. It is stored only in this device's plugin data (`.obsidian/plugins/deborah-remote/data.json`),
never synced, never committed. Treat the bearer like a password.

## Install (iOS / iPadOS, via BRAT)

`.obsidian` does not sync, so the plugin is side-loaded per device.

1. Install **BRAT** from Community Plugins and enable it.
2. BRAT → *Add beta plugin* → this repo URL. For a private repo, first set a
   GitHub PAT (fine-grained, read-only contents) in BRAT settings.
3. Enable **Deborah Remote** in Community Plugins.
4. Settings → **Deborah Remote**: set **Base URL**
   (`https://deborah-2.tail1fd1c8.ts.net/todaystream`) and paste the **bearer**
   from `~/services/todaystream/.bearer` on d2.
5. Ribbon → **Today Stream** (radio icon) opens the live view. Remote control
   connects automatically.

## Driving it from d2

Use the `obs` CLI (`~/bin/obs`):

```
obs notice "hello from d2"
obs openstream
obs open "05-Daily/2026-08-28.md" reading
obs mode reading
obs command editor:toggle-source
obs append "00-Inbox/capture.md" "a line from d2"
obs eval "new Notice('files: '+app.vault.getMarkdownFiles().length)"
```

## Files

- `main.js` — plugin (plain CommonJS, no build step)
- `manifest.json`, `versions.json` — plugin + BRAT metadata
- `styles.css` — stream-view styling (theme-var based)

Server side lives in `~/services/todaystream/` on d2.
