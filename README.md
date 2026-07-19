# Journey Studio

Turn **Playwright test results** into narrated, human-paced **how-to guide videos**.
Standalone: point it at any `results.json` — no coupling to your test repo.
Zero runtime dependencies — Node built-ins plus the `ffmpeg`/`ffprobe`/`unzip`
already on your machine. MIT licensed.

## Requires
- Node ≥ 18 — nothing to `npm install`, there are no dependencies
- `ffmpeg`/`ffprobe` on your PATH (only needed when you splice the final video)

## Quick start

**1. Make your Playwright run produce ingestible results** — videos plus a JSON
report. The whole setup is three settings in your test project's config:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: { video: 'on', trace: 'on' },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
});
```

The counterintuitive part is `'on'`. Playwright's defaults keep videos and traces
only when a test *fails* — but guides are built from tests that *pass*, so the
defaults throw away exactly the artifacts you need. The trace does the heavy
lifting: every `expect()`, selector, API call and user-facing message the test
triggered is mined into the step timeline, so a raw recording becomes a
chaptered walkthrough. And with `results.json` written inside `test-results/`,
that one folder holds report + videos + traces together — it's the folder you
drop in step 3.

**2. Start the dashboard:**

```bash
git clone https://github.com/wjm2202/journey-studio && cd journey-studio
node bin/journey-studio.mjs serve      # → http://localhost:8777/dashboard.html
```

**3. Drag your report folder onto the page.** Drop the whole folder that holds
`results.json` and its videos/traces (usually your `test-results/` directory)
anywhere on the dashboard. It uploads, ingests, and every spec appears as a
card — pass/fail/skip across the whole run, filterable, with every passing test
ready as a guide. Click **work on this →** to open the narration studio: watch
the journey at human pace with a step-by-step teleprompter, press **Record**,
and narrate in one take.

Prefer the terminal? These do the same as the drag-and-drop:

```bash
node bin/journey-studio.mjs ingest --from path/to/test-results  # ingest one report folder
./drop                                # ingest every folder dropped into ./inbox, then serve
node bin/journey-studio.mjs path/to/results.json                # classic: point at a report
```

## What it does
Parses the report into one bundle per guide under `./guides/<slug>/`:
`guide.json` (steps + video-relative offsets), `narration-brief.md` (the
AI-readable context pack — see below), `journey.fingerprint.json`
(stale-detection hash), `raw.webm` (the test's video), and a top-level
`registry.json`. The dashboard is the production queue.

- **Rich guides** (★): tests carrying a `{type:'guide'}` annotation + a
  `guide-timeline` attachment (from the optional `narratedStep` helper) — precise
  chapters, objective slug, category.
- **Basic guides**: any other *passed* test that has a video — chapters derived
  from its `test.step` entries.

Run it on the machine where the tests ran (Playwright attachment paths are
absolute); otherwise the bundle still builds but the video won't be found.

## Trace mining — context a basic guide gets for free
When chapters come from the trace (no authored `test.step`s), the ingest mines
the trace deeper so even a basic guide is narratable:

- **checks** — every `expect()` (runner message + matcher + selector via the
  browser-trace twin) bucketed per step. These are the "what this proves" lines.
  Mined checks live in `steps[].checks`, NEVER in `steps[].assertions` — that
  stays the author-declared list feeding the journey fingerprint.
- **sees** — page `<title>` + `<h1>` from the trace's frame snapshots: what the
  viewer is looking at while a step runs.
- **action detail** — each action carries its real `selector`/`value`/`url`.
  Values typed into sensitive fields (card/CVC/password/token) are masked; all
  mined text passes the secret scrubber.
- **tiled chapters** — step windows cover the whole clip (no dead gaps), so the
  polling and provisioning that happen *between* navigations are attributed to a
  step instead of dumped at the end.

## narration-brief.md — the AI context pack
One deterministic markdown file per guide: per step, what the user **does**,
what the screen **shows**, what the test **verifies**, and what happened
**behind the scenes** (polling folded to one line). Feed it to an AI to draft
one narration line per step into `steps[].narration` — the human voice-over
stays the source of truth (draft mode only).

## Security
`serve` binds `127.0.0.1` only — the server can upload, ingest and soft-remove
files, so it should never face your LAN. Pass `--host 0.0.0.0` only if you
understand what that exposes. Nothing is ever hard-deleted: destructive actions
move data into `guides/_to_delete/` for a human to empty.

## Roadmap (next pieces)
- AI narration draft (narration-brief.md → `steps[].narration` proposals)
- Studio: import lib/collapse.mjs instead of the mirrored inline copy

## License
MIT © Glen Osborne (Parametric Memory). The bundled band font is a DejaVu
font — see `assets/FONT-LICENSE.txt`.

## Optional: rich guides
Copy `playwright/narrated-step.ts` into your Playwright project, import `test`/`expect`
from it in a `*.guide.spec.ts`, declare the objective as a `{type:'guide'}` annotation,
and wrap moments in `guide.step(title, {hint,testId,assertions}, fn)`. Run with the JSON
reporter — those tests then show as ★ rich guides with precise chapters.

## Splice → finished video
Once a guide has a `voice.webm` (from the Narration Studio, coming next; or drop your own),
build the finished video — slowed to human pace, with the burned-in bottom **step band**,
your voice muxed in, and the intro prepended by your existing `add_intro.sh`:

```bash
node bin/journey-studio.mjs splice rotate-api-key \
  --add-intro ~/videos/add_intro.sh \
  --intro     ~/videos/my_intro_1920x1080.mp4
# or export ADD_INTRO / INTRO once and just: ... splice rotate-api-key
```

- The screen recording is **full-width, never covered** — the step band is added *below* it (`W × (H+band)`).
- Without a `voice.webm` it renders a **band-only preview**; without `--add-intro` it stops at the body.
- The intro is your proven `add_intro.sh` (CRF 16, VFR-safe, stamped) — reused, not reinvented. A bundled DejaVu font is used for the band (override with `--font` later).

## Narrate (voice-over mode) — the Studio
`journey-studio serve` → open the dashboard → click **work on this →** on a guide.
The Studio plays the video at human pace (1/rate) with a live current-step / next-step
teleprompter (and the downstream context, once enrichment fills it in). Press **Record**,
narrate the whole guide **in one take** while you watch, then **Stop** (or let the video
end). Your `voice.webm` saves straight back into the guide folder over the local server,
and the dashboard status flips to **narrated**. Then:

```bash
node bin/journey-studio.mjs splice <slug> --add-intro ~/…/YouTube/add_intro.sh --intro ~/…/pm_youtube_intro_1920x1080.mp4
```

Because you narrate against the *slowed* playback, the voice is already time-aligned to the
human-paced final render — no separate cut file needed.
