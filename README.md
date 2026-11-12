# BenchSteps

A small offline-first app for running lab protocols at the bench. Works in any modern browser on desktop and Android, and installs as an app (PWA). No build step, no dependencies – just static files.

## Features

- **Protocol list** with search; create, edit, duplicate, delete.
- **Checklist view** – tap a step to tick it off; progress is remembered between visits.
- **Focus mode** – one step at a time in large text. `✓ Done · Next`, Back, Skip, swipe left/right on a phone, arrow keys / Enter / Space on desktop. `A−` / `A+` change text size.
- **Step timers** – give any step a duration; start it from the checklist or focus mode. Beeps + vibrates when finished and shows a banner.
- **Screen stays on** while a protocol is open, in both checklist and focus mode (where the browser supports Wake Lock). On by default; toggle it with the ☀ button on the protocol screen or in ⚙ Settings.
- **Optional steps** – tag a step as optional; it doesn't count toward progress or block finishing.
- **Master mix calculator** – attach one to any step (presets for qPCR SYBR / TaqMan, or build your own). At the bench enter samples, replicates and extra wells (e.g. no-template control); it gives the volume of each component for the whole mix, with a safety margin (default 10%, editable), plus the per-well dispense volume. Components marked "not in mix" (e.g. template) are listed per well. Preset volumes are typical starting points – check them against your kit and primer concentrations.
- **Run log** – "Finish & log run" records completion and resets the checklist.
- **Offline** after the first load.
- **Sync between devices** (optional) via a private GitHub Gist, plus JSON export/import.

## Run locally

```bash
python -m http.server 8080
```

Then open <http://localhost:8080>. (Service workers need `http://localhost` or `https`, so don't open `index.html` as a `file://` URL.)

## Publish on GitHub Pages

1. Create a GitHub repo and push these files to the root of the `main` branch.
2. Repo → **Settings → Pages** → *Deploy from a branch* → `main` / `(root)`.
3. Open `https://<your-username>.github.io/<repo>/` on your Android phone in Chrome → menu → **Install app** / **Add to Home screen**.

All paths are relative, so it works under the `/<repo>/` sub-path. After you push an update, open the app twice to pick it up (the first open serves the cached copy and refreshes it in the background). Bump `VERSION` in `sw.js` if you ever need to force-clear the cache.

## Syncing protocols between devices

GitHub Pages is static hosting, so there is no server to hold your data. Instead the app can store your protocols in a **private Gist in your own GitHub account**:

1. GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → generate one with **only the `gist` scope** and a short expiry.
2. In the app: ⚙ → paste the token → **Connect & sync**. Leave *Gist ID* empty on your first device. The app creates the gist and shows its ID.
3. On every other device: paste the same token **and** the Gist ID.

How it behaves:

- Syncs on app open, when you return to the app, and ~2 s after you save/delete a protocol; or tap **Sync now**.
- Merge rule is **newest edit wins per protocol** (deletes are remembered so they propagate). If you edit the *same* protocol on two devices while offline, the later save overwrites the other – no merging inside a protocol.
- Only protocols are synced. Checklist progress, timers and run history stay on each device.
- The token is stored in the browser's local storage on that device only. Treat it like a password.

If you'd rather not use a token, use ⚙ → **Export** / **Import** to move a JSON file between devices.

## Data

Everything is in `localStorage` under the key `benchsteps.v1`. Clearing site data erases it – export or sync to keep a copy.

## Known limits

- Timers use the clock, so they stay correct if the tab is backgrounded, but the **beep can't play while the phone is locked or the app is suspended**. Keep the screen on (focus mode does this) if you rely on the alert.
- Sync runs in the foreground only – there's no background sync.
