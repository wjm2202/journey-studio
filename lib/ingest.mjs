// ingest — turn dropped Playwright *report folders* into indexed batches of guides.
// The user drops (or points at) a folder that holds a Playwright JSON report plus its
// video/trace artifacts. We store it as a BATCH under guides/<batchId>/ and record it
// in guides/index.json — the browsable folder index.
//
// fs-facing, but the fiddly logic (batch id, artifact rebasing, index merge) is pulled
// out as PURE functions so it can be unit-tested without a filesystem.
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync, renameSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildFromReport, summarizeReport, outcomesFromReport } from './build-core.mjs';
import { enrichGuide, enrichStats, scrubText } from './enrich.mjs';
import { chaptersWithActions } from './trace-actions.mjs';
import { buildBrief } from './brief.mjs';
import { slugify } from './timeline.mjs';

// ───────────────────────── pure helpers (unit-tested) ─────────────────────────

/** A stable batch id from a folder path — the folder's own name, slugified. */
export function batchIdFromPath(p) {
  const base = path.basename(String(p).replace(/[\\/]+$/, ''));
  return slugify(base) || 'batch';
}

/** Candidate on-disk locations for an artifact path that was recorded on another
 *  machine. PURE — returns the paths to try in priority order; the caller checks
 *  existence. Handles: (1) the path as recorded (works on the origin machine),
 *  (2) rebased by the last `test-results/` segment under each root, (3) basename
 *  directly under each root. */
export function rebaseCandidates(absPath, roots = []) {
  const out = [String(absPath)];
  const norm = String(absPath).replace(/\\/g, '/');
  const marker = norm.lastIndexOf('/test-results/');
  const tail = marker !== -1 ? norm.slice(marker + 1) : null; // 'test-results/…/video.webm'
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  for (const r of roots) {
    if (tail) out.push(path.join(r, tail));
    out.push(path.join(r, base));
  }
  return out;
}

/** Replace any batch with the same id, newest-first. PURE. `entry.ingestedAt`
 *  is the sort key so callers control the clock (testable). */
export function mergeIndex(index, entry) {
  const batches = ((index && index.batches) || []).filter((b) => b.id !== entry.id);
  batches.push(entry);
  batches.sort((a, b) => String(b.ingestedAt).localeCompare(String(a.ingestedAt)));
  return { schema: 'journey-index/v1', generatedAt: entry.ingestedAt, batches };
}

/** True if a parsed object looks like a Playwright JSON report. PURE. */
export function looksLikeReport(obj) {
  return !!obj && Array.isArray(obj.suites);
}

// ───────────────────────── fs / exec helpers ─────────────────────────

/** Walk a folder (bounded depth) for the first JSON file that parses as a
 *  Playwright report. Prefers files named results/report.json. */
export function findReportFile(dir, maxDepth = 4) {
  const hits = [];
  (function walk(d, depth) {
    if (depth > maxDepth) return;
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        hits.push(full);
      }
    }
  })(dir, 0);
  // rank: preferred names first, then shallower paths
  hits.sort((a, b) => {
    const score = (p) => (/(?:^|\/)(results|report)\.json$/i.test(p) ? 0 : 1) * 100 + p.split(path.sep).length;
    return score(a) - score(b);
  });
  for (const f of hits) {
    try { if (looksLikeReport(JSON.parse(readFileSync(f, 'utf8')))) return f; } catch {}
  }
  return null;
}

/** First existing candidate for an artifact, or null. */
export function resolveArtifact(absPath, roots) {
  if (!absPath) return null;
  for (const c of rebaseCandidates(absPath, roots)) { if (existsSync(c)) return c; }
  return null;
}

/** Extract and concatenate every `*.network` file out of a Playwright trace.zip.
 *  Returns '' if unzip is unavailable or the zip has none. Never throws. */
export function extractNetworkText(traceZip) {
  if (!traceZip || !existsSync(traceZip)) return '';
  try {
    const list = execFileSync('unzip', ['-Z1', traceZip], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.network'));
    let text = '';
    for (const name of list) {
      try { text += execFileSync('unzip', ['-p', traceZip, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch {}
    }
    return text;
  } catch { return ''; }
}

/** Extract and concatenate every `*.trace` file (the action timeline) from a trace.zip. */
export function extractTraceText(traceZip) {
  if (!traceZip || !existsSync(traceZip)) return '';
  try {
    const list = execFileSync('unzip', ['-Z1', traceZip], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.trace'));
    let text = '';
    for (const name of list) {
      try { text += execFileSync('unzip', ['-p', traceZip, name], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); } catch {}
    }
    return text;
  } catch { return ''; }
}

function ffprobeMs(file) {
  try {
    const s = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
    return Number.isFinite(s) ? Math.round(s * 1000) : 0;
  } catch { return 0; }
}

function loadOpenApi(p) {
  if (!p) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Ingest ONE dropped report folder into a batch under `out`.
 * @returns the batch index entry (also mirrored to guides/<batchId>/registry.json).
 */
export function ingestFolder(srcDir, { out, openapiPath = null, batchId = null, now = '' , log = () => {} } = {}) {
  const src = path.resolve(srcDir);
  const reportPath = findReportFile(src);
  if (!reportPath) throw new Error(`no Playwright JSON report found under ${src}`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const id = batchId || batchIdFromPath(src);
  const batchOut = path.join(out, id);
  const roots = [src, path.dirname(reportPath), path.resolve(reportPath, '..', '..'), path.resolve(reportPath, '..', '..', '..')];
  const openapi = loadOpenApi(openapiPath);

  // pass 1 — resolve + copy media, measure real durations
  const durations = {};
  let missing = 0;
  for (const g of buildFromReport(report).guides) {
    const dir = path.join(batchOut, g.slug);
    mkdirSync(dir, { recursive: true });
    const video = resolveArtifact(g.videoPath, roots);
    if (video) { const dest = path.join(dir, 'raw.webm'); copyFileSync(video, dest); durations[g.slug] = ffprobeMs(dest); }
    else if (g.videoPath) missing++;
    const trace = resolveArtifact(g.tracePath, roots);
    if (trace) copyFileSync(trace, path.join(dir, 'trace.zip'));
  }

  // pass 2 — real durations → aligned; enrich; write bundles
  const { guides, registry } = buildFromReport(report, { durations });
  const guideSummaries = [];
  for (const g of guides) {
    const dir = path.join(batchOut, g.slug);
    let bundle = {
      objective: g.slug, title: g.meta.title, category: g.meta.category ?? 'uncategorized',
      assumes: g.meta.assumes ?? [], journeyRef: g.meta.journeyRef ?? null, specFile: g.file ?? null,
      annotated: g.annotated, video: g.videoPath ? `${g.slug}/raw.webm` : null,
      durationMs: g.durationMs, aligned: g.aligned, steps: g.steps,
    };
    // enrichment — trace → per-step downstream API calls (secrets scrubbed inside enrich)
    const traceZip = path.join(dir, 'trace.zip');
    const networkText = extractNetworkText(traceZip);
    let t0;
    if (!bundle.steps.length) {
      const { chapters, t0: videoStart } = chaptersWithActions(extractTraceText(traceZip), { videoMs: durations[g.slug] || 0 });
      bundle.steps = chapters.map((c) => ({
        id: c.id, index: c.index, title: c.title, hint: c.hint ?? null, ...(c.post ? { post: true } : {}),
        startMs: c.startMs, endMs: c.endMs, testId: null,
        assertions: c.assertions ?? [],            // author-declared only — feeds the fingerprint
        checks: c.checks ?? [],                    // mined from the trace — never fingerprinted
        sees: c.sees ?? null,                      // page title + heading from frame snapshots
        messages: c.messages ?? [],                // what the app TOLD the user (alerts/dialogs/status)
        actions: c.actions ?? [], downstream: [],
        console: (c.console ?? []).map((e) => ({ ...e, text: scrubText(e.text) })), narration: null,
      }));
      t0 = videoStart;
    }
    bundle = enrichGuide(bundle, { networkText, openapi, startMs: t0 });
    const ds = enrichStats(bundle);

    writeFileSync(path.join(dir, 'guide.json'), JSON.stringify(bundle, null, 2));
    writeFileSync(path.join(dir, 'narration-brief.md'), buildBrief(bundle, { fingerprint: g.fingerprint, batch: id }));
    // explicit initial state — kills the dashboard's 404-per-guide console noise;
    // never overwritten so a narrated/spliced state survives re-ingest
    const statePath = path.join(dir, 'state.json');
    if (!existsSync(statePath)) writeFileSync(statePath, JSON.stringify({ state: 'captured' }, null, 2));
    writeFileSync(path.join(dir, 'journey.fingerprint.json'), JSON.stringify(
      { schema: 'journey-fingerprint/v1', slug: g.slug, hash: g.fingerprint, batch: id,
        steps: g.steps.map((s) => ({ title: s.title, testId: s.testId, assertions: s.assertions })) }, null, 2));
    guideSummaries.push({
      slug: g.slug, title: bundle.title, category: bundle.category, annotated: g.annotated,
      aligned: g.aligned, durationMs: g.durationMs, steps: bundle.steps.length, downstream: ds.total,
      hasVideo: durations[g.slug] != null,   // dashboard renders cards from this — no per-guide fetch
    });
    log(`  ${g.annotated ? '★' : '·'} ${g.slug}  ${bundle.steps.length} steps  ${g.durationMs}ms  aligned=${g.aligned}  downstream=${ds.total}`);
  }

  mkdirSync(batchOut, { recursive: true });
  writeFileSync(path.join(batchOut, 'registry.json'), JSON.stringify(registry, null, 2));

  // every spec's outcome, linked to its guide when one was produced
  const tests = outcomesFromReport(report).map((o) => {
    const g = guides.find((x) => x.specTitle === o.title && (x.file ?? null) === (o.file ?? null));
    return g ? { ...o, slug: g.slug } : o;
  });

  return {
    id, name: path.basename(src), source: src, report: reportPath,
    ingestedAt: now, guideCount: guideSummaries.length, missingVideos: missing,
    results: summarizeReport(report),   // passed/failed/skipped/flaky across the WHOLE run
    tests,                              // per-spec human-readable outcomes (dashboard filter)
    guides: guideSummaries,
  };
}

/** Read → merge → write guides/index.json for one batch entry. */
export function writeIndex(out, entry) {
  const indexPath = path.join(out, 'index.json');
  let existing = null;
  try { existing = JSON.parse(readFileSync(indexPath, 'utf8')); } catch {}
  const next = mergeIndex(existing, entry);
  mkdirSync(out, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(next, null, 2));
  return next;
}

// ───────────────────────── soft-remove (never hard-deletes) ─────────────────────────
// "Delete" in Journey Studio is a MOVE into guides/_to_delete/ plus an index update.
// Hard-deleting is a human action (ground rule): the human empties _to_delete/ themselves.

/** Remove a batch from a parsed index. PURE. */
export function removeBatchFromIndex(index, id) {
  const batches = ((index && index.batches) || []).filter((b) => b.id !== id);
  return { schema: 'journey-index/v1', generatedAt: (index && index.generatedAt) || '', batches };
}

/** Remove one guide from a batch index entry. PURE. */
export function removeGuideFromEntry(entry, slug) {
  const guides = (entry.guides || []).filter((g) => g.slug !== slug);
  return { ...entry, guides, guideCount: guides.length };
}

const stampOf = (now) => String(now).replace(/[^0-9TZ]/g, '').slice(0, 15) || 'x';
function toDeleteDest(out, name, now) {
  const destDir = path.join(out, '_to_delete');
  mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, `${stampOf(now)}-${name}`);
  let k = 2;
  while (existsSync(dest)) dest = path.join(destDir, `${stampOf(now)}-${name}-${k++}`);
  return dest;
}

/** Soft-remove a whole batch: guides/<id> → guides/_to_delete/, dropped from index.json. */
export function removeBatch(out, id, now = '') {
  if (!id || id === '_to_delete') return null;
  const src = path.join(out, id);
  if (!existsSync(src)) return null;
  const dest = toDeleteDest(out, id, now);
  renameSync(src, dest);
  const indexPath = path.join(out, 'index.json');
  let index = null; try { index = JSON.parse(readFileSync(indexPath, 'utf8')); } catch {}
  const next = removeBatchFromIndex(index, id);
  writeFileSync(indexPath, JSON.stringify(next, null, 2));
  return { removed: id, movedTo: dest };
}

/** Soft-remove one guide: folder moved to _to_delete/, registry + index updated. */
export function removeGuide(out, batchId, slug, now = '') {
  if (!batchId || batchId === '_to_delete' || !slug) return null;
  const src = path.join(out, batchId, slug);
  if (!existsSync(src)) return null;
  const dest = toDeleteDest(out, `${batchId}-${slug}`, now);
  renameSync(src, dest);
  const regPath = path.join(out, batchId, 'registry.json');
  try {
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    delete reg[slug];
    writeFileSync(regPath, JSON.stringify(reg, null, 2));
  } catch {}
  const indexPath = path.join(out, 'index.json');
  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const batches = (index.batches || []).map((b) => (b.id === batchId ? removeGuideFromEntry(b, slug) : b));
    writeFileSync(indexPath, JSON.stringify({ ...index, batches }, null, 2));
  } catch {}
  return { removed: `${batchId}/${slug}`, movedTo: dest };
}

/** Ingest every immediate sub-folder of an inbox. Returns the batch entries. */
export function ingestInbox(inboxDir, opts = {}) {
  const inbox = path.resolve(inboxDir);
  let ents = [];
  try { ents = readdirSync(inbox, { withFileTypes: true }); } catch { return []; }
  const entries = [];
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === '_processed') continue;
    const dir = path.join(inbox, e.name);
    try {
      const entry = ingestFolder(dir, opts);
      writeIndex(opts.out, entry);
      entries.push(entry);
    } catch (err) {
      (opts.log || (() => {}))(`  ✗ ${e.name}: ${err.message}`);
    }
  }
  return entries;
}
