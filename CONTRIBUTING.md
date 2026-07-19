# Contributing to Journey Studio

Thanks for looking under the hood. Ground rules that keep this tool what it is:

- **Zero runtime dependencies.** The whole tool is Node ≥ 18 built-ins plus the
  system `ffmpeg`/`ffprobe`/`unzip` it shells out to. PRs that add npm runtime
  dependencies need a very strong case.
- **We write tests for everything.** `node --test` must be green; new behaviour
  ships with tests in `test/`. Pure logic lives in `lib/` where it can be tested
  without a filesystem; the CLI (`bin/`) stays a thin shell around it.
- **The web UIs are dependency-free single files** (`web/*.html`, inline CSS/JS)
  served live by the built-in server. Logic mirrored from `lib/` (e.g. the
  poll-collapse) is marked with a comment — keep mirrors in sync; `lib/` tests
  are the contract.
- **Never hard-delete user data.** Destructive UI actions move files into
  `guides/_to_delete/` — emptying it is the human's job. Keep it that way.
- **Mined text is scrubbed.** Anything extracted from traces (titles, messages,
  errors) passes the secret scrubber in `lib/enrich.mjs`; extend the patterns
  rather than bypassing them.

Dev loop:

```bash
node --test                                  # full suite
node bin/journey-studio.mjs serve --dir guides   # UI pages are served live from web/
```
