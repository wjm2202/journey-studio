// Tests for lib/ingest.mjs — pure helpers + a real folder round-trip on a tmp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  batchIdFromPath, rebaseCandidates, mergeIndex, looksLikeReport,
  findReportFile, resolveArtifact, ingestFolder, writeIndex,
  removeBatchFromIndex, removeGuideFromEntry, removeBatch, removeGuide,
} from '../lib/ingest.mjs';

test('batchIdFromPath slugifies the folder name and tolerates trailing slash', () => {
  assert.equal(batchIdFromPath('/a/b/Free Tier Run/'), 'free-tier-run');
  assert.equal(batchIdFromPath('/a/b/results'), 'results');
});

test('rebaseCandidates offers the recorded path, a test-results rebase, and a basename', () => {
  const cands = rebaseCandidates('/Users/alice/proj/test-results/spec-x/video.webm', ['/root/drop']);
  assert.equal(cands[0], '/Users/alice/proj/test-results/spec-x/video.webm');
  assert.ok(cands.includes('/root/drop/test-results/spec-x/video.webm'));
  assert.ok(cands.includes('/root/drop/video.webm'));
});

test('mergeIndex replaces same-id batch and sorts newest-first', () => {
  let idx = mergeIndex(null, { id: 'a', ingestedAt: '2026-01-01' });
  idx = mergeIndex(idx, { id: 'b', ingestedAt: '2026-02-01' });
  idx = mergeIndex(idx, { id: 'a', ingestedAt: '2026-03-01' });
  assert.equal(idx.batches.length, 2);
  assert.equal(idx.batches[0].id, 'a');
  assert.equal(idx.batches[0].ingestedAt, '2026-03-01');
});

test('looksLikeReport recognises a suites array', () => {
  assert.equal(looksLikeReport({ suites: [] }), true);
  assert.equal(looksLikeReport({ foo: 1 }), false);
  assert.equal(looksLikeReport(null), false);
});

function makeDrop() {
  const root = mkdtempSync(path.join(tmpdir(), 'js-ingest-'));
  const trDir = path.join(root, 'test-results', 'demo-login');
  mkdirSync(trDir, { recursive: true });
  const videoAbs = path.join(trDir, 'video.webm');
  writeFileSync(videoAbs, 'FAKEWEBM');
  const report = {
    suites: [{
      title: 'login.spec.ts', file: 'login.spec.ts',
      specs: [{
        title: 'user can log in',
        tests: [{
          annotations: [{ type: 'guide', description: JSON.stringify({ objective: 'log-in', title: 'Log in', category: 'auth' }) }],
          results: [{
            status: 'passed',
            attachments: [
              { name: 'video', path: videoAbs, contentType: 'video/webm' },
              { name: 'guide-timeline', contentType: 'application/json',
                body: Buffer.from(JSON.stringify({ chapters: [
                  { id: 's01', index: 1, title: 'Open login', hint: null, startMs: 0, endMs: 1000, testId: null, assertions: [] },
                ] })).toString('base64') },
            ],
          }],
        }],
      }],
    }],
  };
  writeFileSync(path.join(root, 'results.json'), JSON.stringify(report));
  return { root, videoAbs };
}

test('findReportFile locates the Playwright report inside a dropped folder', () => {
  const { root } = makeDrop();
  const found = findReportFile(root);
  assert.ok(found && found.endsWith('results.json'));
});

test('resolveArtifact finds the recorded path directly', () => {
  const { videoAbs } = makeDrop();
  assert.equal(resolveArtifact(videoAbs, ['/nonexistent']), videoAbs);
});

test('ingestFolder builds a batch, copies media, writes guide.json + registry', () => {
  const { root } = makeDrop();
  const out = mkdtempSync(path.join(tmpdir(), 'js-out-'));
  const entry = ingestFolder(root, { out, now: '2026-07-19T00:00:00Z' });
  assert.equal(entry.guideCount, 1);
  assert.equal(entry.guides[0].slug, 'log-in');
  assert.equal(entry.guides[0].annotated, true);
  assert.equal(entry.guides[0].hasVideo, true, 'summary carries hasVideo for the dashboard');
  const gdir = path.join(out, entry.id, 'log-in');
  assert.ok(existsSync(path.join(gdir, 'guide.json')), 'guide.json written');
  assert.ok(existsSync(path.join(gdir, 'narration-brief.md')), 'narration brief written');
  assert.ok(existsSync(path.join(gdir, 'raw.webm')), 'video copied');
  assert.ok(existsSync(path.join(out, entry.id, 'registry.json')), 'per-batch registry written');
  const bundle = JSON.parse(readFileSync(path.join(gdir, 'guide.json'), 'utf8'));
  assert.equal(bundle.title, 'Log in');
  assert.ok(Array.isArray(bundle.steps[0].downstream));
});

test('summarizeReport counts passed/failed/skipped/flaky across the whole run', async () => {
  const { summarizeReport } = await import('../lib/build-core.mjs');
  const t = (results) => ({ results });
  const report = { suites: [{ specs: [{ tests: [
    t([{ status: 'passed' }]),                                    // passed
    t([{ status: 'failed' }, { status: 'passed' }]),              // flaky (retry passed)
    t([{ status: 'failed' }]),                                    // failed
    t([{ status: 'timedOut' }]),                                  // failed
    t([{ status: 'skipped' }]),                                   // skipped
    t([]),                                                        // no attempts → skipped
  ] }] }] };
  assert.deepEqual(summarizeReport(report), { passed: 1, failed: 2, skipped: 2, flaky: 1, total: 6 });
});

test('ingestFolder carries the run summary in its index entry', () => {
  const { root } = makeDrop();
  const out = mkdtempSync(path.join(tmpdir(), 'js-sum-'));
  const entry = ingestFolder(root, { out, now: '2026-07-19T00:00:00Z' });
  assert.deepEqual(entry.results, { passed: 1, failed: 0, skipped: 0, flaky: 0, total: 1 });
});

test('outcomesFromReport strips ANSI, scrubs and truncates failure messages', async () => {
  const { outcomesFromReport } = await import('../lib/build-core.mjs');
  const report = { suites: [{ file: 'x.spec.ts', specs: [
    { title: 'boom', tests: [{ results: [{ status: 'failed', error: { message: '[2mExpected[22m 200 got 500 key=mmk_SECRETKEY123' } }] }] },
    { title: 'ok', tests: [{ results: [{ status: 'passed' }] }] },
  ] }] };
  const [fail, pass] = outcomesFromReport(report);
  assert.equal(fail.outcome, 'failed');
  assert.ok(!fail.error.includes(''), 'ANSI stripped');
  assert.ok(!fail.error.includes('mmk_SECRETKEY123'), 'secrets scrubbed');
  assert.ok(fail.error.includes('Expected 200 got 500'));
  assert.equal(pass.outcome, 'passed');
  assert.equal(pass.error, null);
});

test('ingestFolder links per-spec outcomes to their guide slug', () => {
  const { root } = makeDrop();
  const out = mkdtempSync(path.join(tmpdir(), 'js-out2-'));
  const entry = ingestFolder(root, { out, now: '2026-07-19T00:00:00Z' });
  assert.equal(entry.tests.length, 1);
  assert.equal(entry.tests[0].outcome, 'passed');
  assert.equal(entry.tests[0].slug, 'log-in', 'outcome linked to the guide it produced');
});

test('removeBatchFromIndex / removeGuideFromEntry are pure filters', () => {
  const idx = { batches: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual(removeBatchFromIndex(idx, 'a').batches.map((b) => b.id), ['b']);
  const entry = { id: 'a', guideCount: 2, guides: [{ slug: 'x' }, { slug: 'y' }] };
  const next = removeGuideFromEntry(entry, 'x');
  assert.deepEqual(next.guides.map((g) => g.slug), ['y']);
  assert.equal(next.guideCount, 1);
});

test('removeGuide + removeBatch SOFT-remove: moved to _to_delete/, index + registry updated, nothing hard-deleted', () => {
  const { root } = makeDrop();
  const out = mkdtempSync(path.join(tmpdir(), 'js-rm-'));
  const entry = ingestFolder(root, { out, now: '2026-07-19T00:00:00Z' });
  writeIndex(out, entry);

  // guide-level
  const g = removeGuide(out, entry.id, 'log-in', '2026-07-19T01:00:00Z');
  assert.ok(g && existsSync(g.movedTo), 'guide folder moved, still on disk');
  assert.ok(g.movedTo.includes(`_to_delete${path.sep}`), 'moved under _to_delete');
  assert.ok(!existsSync(path.join(out, entry.id, 'log-in')), 'gone from the batch');
  const reg = JSON.parse(readFileSync(path.join(out, entry.id, 'registry.json'), 'utf8'));
  assert.ok(!('log-in' in reg), 'dropped from registry');
  let idx = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.equal(idx.batches[0].guideCount, 0, 'index entry updated');

  // batch-level
  const b = removeBatch(out, entry.id, '2026-07-19T02:00:00Z');
  assert.ok(b && existsSync(b.movedTo), 'batch folder moved, still on disk');
  assert.ok(!existsSync(path.join(out, entry.id)), 'batch gone from guides');
  idx = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.equal(idx.batches.length, 0, 'batch dropped from index');
  assert.equal(removeBatch(out, '_to_delete'), null, '_to_delete itself is not removable');
});

test('writeIndex creates and updates guides/index.json idempotently', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'js-idx-'));
  writeIndex(out, { id: 'batch-a', name: 'A', ingestedAt: '2026-07-19T00:00:00Z', guideCount: 1, guides: [] });
  writeIndex(out, { id: 'batch-a', name: 'A', ingestedAt: '2026-07-19T01:00:00Z', guideCount: 2, guides: [] });
  const idx = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.equal(idx.batches.length, 1);
  assert.equal(idx.batches[0].guideCount, 2);
});
