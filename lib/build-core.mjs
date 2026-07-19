// build-core — PURE transform: a Playwright json report -> guide bundles + registry.
// No fs, no ffprobe (the CLI does those). Works on ANY Playwright results:
//   • tests with a {type:'guide'} annotation + a 'guide-timeline' attachment
//     (added by the optional narratedStep helper) become RICH guides;
//   • any other passed test WITH a video becomes a basic guide, chapters
//     derived from its test.step entries.
import { fingerprint, isAligned, slugify } from './timeline.mjs';
import { scrubText } from './enrich.mjs';

function collectTests(suites = [], file) {
  const out = [];
  for (const s of suites) {
    const f = s.file ?? file;
    for (const spec of s.specs ?? []) for (const t of spec.tests ?? []) out.push({ spec, test: t, file: f });
    if (s.suites) out.push(...collectTests(s.suites, f));
  }
  return out;
}
const att = (atts = [], name) => atts.find((a) => a.name === name);

const ANSI = /\[[0-9;]*m/g;   // Playwright error messages carry terminal colours

/** Human-readable outcome of EVERY spec in the report (guides only come from
 *  passing runs, but failures and skips are part of the run's story). PURE.
 *  Outcome from the attempts: last attempt passed after an earlier failure = flaky;
 *  no attempts or skipped = skipped; last passed = passed; anything else = failed.
 *  Failed specs carry their (scrubbed, de-ANSI'd, truncated) error message. */
export function outcomesFromReport(report) {
  const out = [];
  for (const { spec, test: tc, file } of collectTests((report && report.suites) || [])) {
    const rs = tc.results ?? [];
    const last = rs[rs.length - 1];
    let outcome;
    if (!last || last.status === 'skipped') outcome = 'skipped';
    else if (last.status === 'passed') outcome = rs.some((r) => r.status !== 'passed') ? 'flaky' : 'passed';
    else outcome = 'failed';
    const raw = outcome === 'failed' && last && last.error ? (last.error.message || '') : '';
    out.push({
      title: spec.title, file: file ?? null, outcome,
      durationMs: rs.reduce((n, r) => n + (r.duration || 0), 0),
      error: raw ? scrubText(String(raw).replace(ANSI, '')).slice(0, 200) : null,
    });
  }
  return out;
}

/** One-line run summary across ALL tests — derived from outcomesFromReport. PURE. */
export function summarizeReport(report) {
  const out = { passed: 0, failed: 0, skipped: 0, flaky: 0, total: 0 };
  for (const o of outcomesFromReport(report)) { out.total++; out[o.outcome]++; }
  return out;
}

function chaptersFromSteps(res) {
  const steps = (res.steps ?? []).filter((s) => s.category === 'test.step');
  let cursor = 0, i = 0;
  return steps.map((s) => {
    const startMs = cursor;
    cursor += s.duration ?? 0;
    i += 1;
    return { id: 's' + String(i).padStart(2, '0'), index: i, title: s.title, hint: null, testId: null, startMs, endMs: cursor, assertions: [] };
  });
}

export function buildFromReport(report, { durations = {} } = {}) {
  const registry = {};
  const guides = [];
  const seen = new Set();

  for (const { spec, test: tc, file } of collectTests(report.suites)) {
    const res = (tc.results ?? []).find((r) => r.status === 'passed') ?? (tc.results ?? [])[0];
    if (!res || res.status !== 'passed') continue; // a guide must come from a passing run
    const video = att(res.attachments, 'video');
    if (!video) continue; // no video = nothing to make a guide from

    const ann = (tc.annotations ?? []).find((a) => a.type === 'guide');
    const meta = ann?.description
      ? JSON.parse(ann.description)
      : { objective: slugify(spec.title), title: spec.title, category: 'uncategorized' };

    let slug = meta.objective || slugify(spec.title);
    if (seen.has(slug)) {
      if (ann) throw new Error(`duplicate objective slug: ${slug}`); // explicit dup = real error
      let k = 2; while (seen.has(`${slug}-${k}`)) k++; slug = `${slug}-${k}`; // derived dup = auto-number
    }
    seen.add(slug);

    const gt = att(res.attachments, 'guide-timeline');
    let chapters = [];
    if (gt?.body) {
      try { chapters = JSON.parse(Buffer.from(gt.body, 'base64').toString('utf8')).chapters ?? []; } catch {}
    }
    if (!chapters.length) chapters = chaptersFromSteps(res);

    const steps = chapters.map((c) => ({
      id: c.id, index: c.index, title: c.title, hint: c.hint ?? null,
      startMs: c.startMs, endMs: c.endMs, testId: c.testId ?? null,
      assertions: c.assertions ?? [], actions: [], downstream: [], narration: null,
    }));
    const durationMs = durations[slug] ?? 0;
    const aligned = durationMs > 0 ? isAligned(steps, durationMs) : true;
    const trace = att(res.attachments, 'trace');
    const fp = fingerprint(steps);

    guides.push({ slug, meta, file, specTitle: spec.title, steps, durationMs, aligned, fingerprint: fp, videoPath: video.path ?? null, tracePath: trace?.path ?? null, annotated: !!ann });
    registry[slug] = {
      title: meta.title, category: meta.category ?? 'uncategorized', assumes: meta.assumes ?? [],
      journeyRef: meta.journeyRef ?? null, specFile: file ?? null, fingerprint: fp,
      capturable: meta.capturable ?? true, aligned, annotated: !!ann,
    };
  }
  return { guides, registry };
}
