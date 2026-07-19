import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, buildReview, matchesFilter, shortenTokens } from '../lib/brief.mjs';

const bundle = {
  objective: 'p1-purchase', title: 'P1 — purchase provisions a substrate', category: 'payments',
  specFile: 'payment.spec.ts', durationMs: 17320, assumes: ['a Stripe test account'],
  steps: [
    {
      id: 's01', index: 1, title: 'Navigate to "/c/pay/cs_test_b1AsfX94eRoAyWSSP7Tc35le1DLNjw5kk"',
      startMs: 0, endMs: 10000, hint: 'Checkout opens pre-filled', testId: null,
      assertions: ['authored assertion'],
      checks: [{ atMs: 500, title: 'toBeEnabled', selector: 'testid=submit-button' },
        { atMs: 600, title: 'dest never went running', count: 34 }],
      sees: { url: 'https://checkout.stripe.com/c/pay', pageTitle: 'Stripe Checkout', heading: 'Pay now' },
      messages: [{ atMs: 700, selector: '[role="alert"] >> nth=0', text: 'Payment failed — your card was declined.' }],
      actions: [{ title: 'Click submit', atMs: 100, kind: 'interact', selector: '#submit' }],
      downstream: [
        { atMs: 200, method: 'POST', path: '/api/checkout', status: 200, summary: 'Create a Checkout session' },
      ],
      console: [
        { level: 'log', text: 'one', atMs: 1, count: 1 }, { level: 'error', text: 'boom', atMs: 2, count: 1 },
        { level: 'log', text: 'two', atMs: 3, count: 1 }, { level: 'log', text: 'three', atMs: 4, count: 1 },
        { level: 'log', text: 'four', atMs: 5, count: 1 }, { level: 'log', text: 'five', atMs: 6, count: 1 },
        { level: 'log', text: 'six', atMs: 7, count: 1 },
      ],
      narration: null,
    },
    {
      id: 's02', index: 2, title: 'Poll until running', startMs: 10000, endMs: 17320,
      hint: null, testId: null, assertions: [], checks: [], sees: null,
      actions: [0, 1200, 2400, 3600].map((t) => ({ title: 'GET "/api/v1/my-substrate"', atMs: 10000 + t, kind: 'api' })),
      downstream: [0, 1200, 2400, 3600].map((t) => ({ atMs: 10000 + t, method: 'GET', path: '/api/v1/my-substrate', status: 200 })),
      console: [], narration: null,
    },
  ],
};

test('shortenTokens compresses opaque runs, leaves words alone', () => {
  assert.equal(shortenTokens('cs_test_b1AsfX94eRoAyWSSP7Tc35le1DLNjw5kk'), 'cs_test_b1…');
  assert.equal(shortenTokens('GET /api/v1/my-substrate'), 'GET /api/v1/my-substrate');
});

test('buildBrief is deterministic and carries every section', () => {
  const a = buildBrief(bundle, { fingerprint: 'sha256:abc', batch: 'compute' });
  const b = buildBrief(bundle, { fingerprint: 'sha256:abc', batch: 'compute' });
  assert.equal(a, b);
  assert.ok(a.startsWith('# P1 — purchase provisions a substrate'));
  assert.ok(a.includes('- fingerprint: sha256:abc'));
  assert.ok(a.includes('- batch: compute'));
  assert.ok(a.includes('- assumes: a Stripe test account'));
  assert.ok(a.includes('Hint: Checkout opens pre-filled'));
  assert.ok(a.includes('On screen: Stripe Checkout — “Pay now”'));
  assert.ok(a.includes('Does:'));
  assert.ok(a.includes('- interact: Click submit'));
  assert.ok(a.includes('Tells the user:'));
  assert.ok(a.includes('- Payment failed — your card was declined.'));
  assert.ok(a.includes('Verifies:'));
  assert.ok(a.includes('- authored assertion'));
  assert.ok(a.includes('- toBeEnabled [testid=submit-button]'));
  assert.ok(a.includes('- dest never went running ×34'), 'folded poll re-checks carry their count');
  assert.ok(a.includes('Behind the scenes:'));
  assert.ok(a.includes('POST /api/checkout'));
  assert.ok(a.includes('— Create a Checkout session'));
});

test('buildBrief truncates session tokens in step titles', () => {
  const md = buildBrief(bundle);
  assert.ok(!md.includes('cs_test_b1AsfX94eRoAyWSSP7Tc35le1DLNjw5kk'));
  assert.ok(md.includes('cs_test_b1…'));
});

test('buildBrief caps console at 5, errors first', () => {
  const md = buildBrief(bundle);
  const consoleBlock = md.slice(md.indexOf('Console:'));
  assert.ok(consoleBlock.indexOf('error: boom') < consoleBlock.indexOf('log:'));
  assert.ok(md.includes('- … 2 more line(s)'));
});

const ENTRY = {
  id: 'test-results', name: 'test-results', ingestedAt: '2026-07-19T08:00:00Z',
  results: { passed: 2, failed: 1, skipped: 1, flaky: 1, total: 5 },
  tests: [
    { title: 'buys starter', file: 'a.spec.ts', outcome: 'passed', durationMs: 15000, error: null, slug: 'buys-starter' },
    { title: 'flaky retry', file: 'a.spec.ts', outcome: 'flaky', durationMs: 9000, error: null },
    { title: 'refund books balance', file: 'b.spec.ts', outcome: 'failed', durationMs: 8000, error: 'refund row missing' },
    { title: '3DS challenge', file: 'c.spec.ts', outcome: 'skipped', durationMs: 0, error: null },
  ],
};

test('matchesFilter: passed includes flaky; failed/skipped exact; all matches everything', () => {
  assert.ok(matchesFilter({ outcome: 'flaky' }, 'passed'));
  assert.ok(!matchesFilter({ outcome: 'failed' }, 'passed'));
  assert.ok(matchesFilter({ outcome: 'failed' }, 'failed'));
  assert.ok(matchesFilter({ outcome: 'skipped' }, 'all'));
});

test('buildReview: filtered markdown pack with errors fenced and bundle links', () => {
  const failed = buildReview(ENTRY, 'failed');
  assert.ok(failed.includes('## FAILED — refund books balance'));
  assert.ok(failed.includes('```\nrefund row missing\n```'));
  assert.ok(!failed.includes('buys starter'), 'passing specs excluded from failed view');
  assert.ok(failed.includes('Matching "failed": 1 of 4'));
  const passed = buildReview(ENTRY, 'passed');
  assert.ok(passed.includes('## PASSED — buys starter'));
  assert.ok(passed.includes('## FLAKY — flaky retry'), 'flaky counts as passing');
  assert.ok(passed.includes('- bundle: test-results/buys-starter/guide.json'));
  assert.ok(passed.includes('- brief: test-results/buys-starter/narration-brief.md'));
  assert.equal(buildReview(ENTRY, 'failed'), buildReview(ENTRY, 'failed'), 'deterministic');
});

test('buildReview on a legacy entry says re-ingest instead of lying', () => {
  const md = buildReview({ id: 'old', results: {} }, 'all');
  assert.ok(md.includes('no per-spec outcome data'));
});

test('buildBrief renders sustained polling as one line', () => {
  const md = buildBrief(bundle);
  assert.ok(md.includes('polling GET /api/v1/my-substrate — 4 calls'));
});
