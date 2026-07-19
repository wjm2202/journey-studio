// Tests for lib/enrich.mjs — run with `node --test` (zero dep).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrubUrl, parseNetworkLines, entryTimeMs, traceStartMs, pathOf,
  normalizeCall, buildApiIndex, joinOpenApi, groupByChapter, enrichGuide, enrichStats,
} from '../lib/enrich.mjs';

// --- a tiny OpenAPI spec that mirrors the real one's shape (templated {slug}) ---
const SPEC = {
  openapi: '3.0.3',
  paths: {
    '/api/v1/substrates': { get: { summary: 'List substrates', tags: ['Substrates'] } },
    '/api/v1/substrates/{slug}': { get: { summary: 'Get a substrate by slug', tags: ['Substrates'] } },
    '/api/v1/substrates/{slug}/rotate-key': {
      post: { summary: 'Rotate the API key', tags: ['Substrates'], operationId: 'rotateKey' },
    },
  },
};

// --- a synthetic Playwright *.network JSONL blob ---
// monotonic times in ms; two API calls + one static asset + a secret-bearing URL.
const NETWORK = [
  JSON.stringify({ type: 'resource-snapshot', snapshot: {
    _monotonicTime: 1000, time: 12, startedDateTime: '2026-07-19T12:00:00.000Z',
    request: { method: 'GET', url: 'http://localhost:3100/api/v1/substrates', headers: [] },
    response: { status: 200, headers: [] },
  } }),
  '', // blank line tolerated
  'not json at all', // garbage line tolerated
  JSON.stringify({ type: 'resource-snapshot', snapshot: {
    _monotonicTime: 1800, time: 40,
    request: { method: 'POST', url: 'http://localhost:3100/api/v1/substrates/my-sub/rotate-key?token=mmk_SECRETKEY123', headers: [] },
    response: { status: 202, headers: [] },
  } }),
  JSON.stringify({ type: 'resource-snapshot', snapshot: {
    _monotonicTime: 1850, time: 5,
    request: { method: 'GET', url: 'http://localhost:3100/_next/static/chunk.js', headers: [] },
    response: { status: 200, headers: [] },
  } }),
].join('\n');

const GUIDE = {
  slug: 'rotate-key', title: 'Rotate a key',
  steps: [
    { id: 's01', index: 1, title: 'Open substrate', startMs: 0, endMs: 1500, downstream: [] },
    { id: 's02', index: 2, title: 'Rotate the key', startMs: 1500, endMs: 3000, downstream: [] },
  ],
};

test('scrubUrl redacts secret query params and whole-value token patterns', () => {
  assert.equal(scrubUrl('http://x/api?token=abc123&page=2'), 'http://x/api?token=[REDACTED]&page=2');
  assert.match(scrubUrl('http://x/api/keys/mmk_ABCDEF123456'), /\[REDACTED\]/);
  assert.doesNotMatch(scrubUrl('http://x/api/keys/mmk_ABCDEF123456'), /mmk_ABCDEF/);
  // current-format MMPM keys (mmpm_live_/mmpm_test_) are scrubbed too
  assert.doesNotMatch(scrubUrl('http://x/claim?k=mmpm_live_5D8uQ2zzZ9'), /mmpm_live_5D8u/);
  assert.doesNotMatch(scrubUrl('http://x/claim?k=mmpm_test_AbCdEf9012'), /mmpm_test_AbCd/);
  // a plain url is untouched
  assert.equal(scrubUrl('http://x/api/v1/substrates'), 'http://x/api/v1/substrates');
});

test('parseNetworkLines skips blank + garbage lines, keeps entries with a request url', () => {
  const entries = parseNetworkLines(NETWORK);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].request.method, 'GET');
});

test('entryTimeMs prefers _monotonicTime, falls back to startedDateTime', () => {
  assert.equal(entryTimeMs({ _monotonicTime: 42 }), 42);
  assert.equal(entryTimeMs({ startedDateTime: '2026-07-19T12:00:00.000Z' }), Date.parse('2026-07-19T12:00:00.000Z'));
  assert.equal(entryTimeMs({}), null);
});

test('traceStartMs is the minimum timestamp', () => {
  assert.equal(traceStartMs(parseNetworkLines(NETWORK)), 1000);
});

test('pathOf extracts the pathname', () => {
  assert.equal(pathOf('http://localhost:3100/api/v1/substrates?x=1'), '/api/v1/substrates');
  assert.equal(pathOf('/already/a/path'), '/already/a/path');
});

test('normalizeCall rebases atMs to the trace origin and scrubs the url', () => {
  const entries = parseNetworkLines(NETWORK);
  const c = normalizeCall(entries[1], 1000); // the rotate-key call at 1800
  assert.equal(c.atMs, 800);
  assert.equal(c.method, 'POST');
  assert.equal(c.status, 202);
  assert.equal(c.path, '/api/v1/substrates/my-sub/rotate-key');
  assert.doesNotMatch(c.url, /mmk_/); // secret gone
});

test('buildApiIndex + joinOpenApi match templated paths by method', () => {
  const idx = buildApiIndex(SPEC);
  const hit = joinOpenApi({ method: 'POST', path: '/api/v1/substrates/anything/rotate-key' }, idx);
  assert.equal(hit.summary, 'Rotate the API key');
  assert.equal(hit.tag, 'Substrates');
  assert.equal(hit.operationId, 'rotateKey');
  // wrong method -> no match
  assert.equal(joinOpenApi({ method: 'GET', path: '/api/v1/substrates/x/rotate-key' }, idx), null);
  // list path must not swallow the {slug} path
  assert.equal(joinOpenApi({ method: 'GET', path: '/api/v1/substrates' }, idx).summary, 'List substrates');
  assert.equal(joinOpenApi({ method: 'GET', path: '/api/v1/substrates/abc' }, idx).summary, 'Get a substrate by slug');
});

test('groupByChapter places calls in the right window and clamps out-of-range', () => {
  const chapters = GUIDE.steps;
  const buckets = groupByChapter(
    [{ atMs: 0 }, { atMs: 800 }, { atMs: 2000 }, { atMs: 99999 }, { atMs: null }],
    chapters,
  );
  assert.equal(buckets[0].length, 2); // atMs 0 and 800 -> chapter 1
  assert.equal(buckets[1].length, 2); // atMs 2000 -> ch2, 99999 -> clamps to last (ch2); null dropped
});

test('enrichGuide fills downstream per step, drops static assets, strips secrets', () => {
  const out = enrichGuide(GUIDE, { networkText: NETWORK, openapi: SPEC });
  // input not mutated
  assert.deepEqual(GUIDE.steps[0].downstream, []);
  const s1 = out.steps[0].downstream;
  const s2 = out.steps[1].downstream;
  // GET /substrates at atMs 0 -> step 1; POST rotate-key at atMs 800 -> step 1 (window 0..1500)
  assert.equal(s1.length, 2);
  // _next static asset filtered out entirely
  const all = [...s1, ...s2];
  assert.ok(!all.some((d) => d.path.includes('_next')), 'static asset must be dropped');
  // secret never reaches output
  assert.ok(!JSON.stringify(out).includes('mmk_SECRETKEY123'), 'no secret in enriched guide');
  // OpenAPI meaning attached
  const rotate = all.find((d) => d.path.endsWith('/rotate-key'));
  assert.equal(rotate.summary, 'Rotate the API key');
  assert.equal(rotate.tag, 'Substrates');
});

test('enrichStats counts total and per-tag', () => {
  const out = enrichGuide(GUIDE, { networkText: NETWORK, openapi: SPEC });
  const stats = enrichStats(out);
  assert.equal(stats.total, 2);
  assert.equal(stats.byTag.Substrates, 2);
});

test('enrichGuide with no openapi keeps only /api/ paths', () => {
  const out = enrichGuide(GUIDE, { networkText: NETWORK }); // no spec
  const all = out.steps.flatMap((s) => s.downstream);
  assert.equal(all.length, 2); // both api calls kept, static dropped
  assert.equal(all[0].summary, null); // no meaning without a spec
});
