import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTraceSpans, tileChapters, chaptersFromTrace, attachActions, checksFromSpans,
  attachChecks, parseSnapshots, attachSees, chaptersWithActions, safeTitle, prettySelector,
  traceT0, messagesFromSpans, attachMessages,
} from '../lib/trace-actions.mjs';

const J = (rows) => rows.map((o) => JSON.stringify(o)).join('\n');

// runner (Test) + browser (Frame) streams sharing one clock, real-shape rows
const rows = [
  { type: 'before', callId: 'pw:api@1', class: 'Test', method: 'pw:api', title: 'Navigate to "/checkout"', params: { url: 'https://x.test/checkout#frag' }, startTime: 1000 },
  { type: 'after', callId: 'pw:api@1', endTime: 1100 },
  { type: 'before', callId: 'pw:api@2', class: 'Test', method: 'pw:api', title: 'Type "4242424242424242" locator(\'#cardNumber\')', params: { selector: '#cardNumber', text: '4242424242424242' }, startTime: 1200 },
  { type: 'after', callId: 'pw:api@2', endTime: 1300 },
  { type: 'before', callId: 'pw:api@3', class: 'Test', method: 'pw:api', title: 'Fill "Jane Doe" locator(\'#billingName\')', params: { selector: '#billingName', value: 'Jane Doe' }, startTime: 1400 },
  { type: 'after', callId: 'pw:api@3', endTime: 1450 },
  { type: 'before', callId: 'expect@4', class: 'Test', method: 'expect', title: 'Expect "toBeEnabled"', params: { expected: 'Object' }, startTime: 1500 },
  { type: 'after', callId: 'expect@4', endTime: 1510 },
  { type: 'before', callId: 'call@90', class: 'Frame', method: 'expect', stepId: 'expect@4', title: 'Expect "toBeEnabled"', params: { selector: 'internal:testid=[data-testid="submit-button"s]', expression: 'to.be.enabled', isNot: false }, startTime: 1500 },
  { type: 'after', callId: 'call@90', endTime: 1510 },
  { type: 'before', callId: 'expect@5', class: 'Test', method: 'expect', title: 'checkout did not return a hosted url', params: { expected: 'checkout.stripe.com' }, startTime: 5500 },
  { type: 'after', callId: 'expect@5', endTime: 5510 },
  { type: 'before', callId: 'pw:api@6', class: 'Test', method: 'pw:api', title: 'Navigate to "/admin"', params: { url: 'https://x.test/admin' }, startTime: 5000 },
  { type: 'after', callId: 'pw:api@6', endTime: 5100 },
];
const messageRows = [
  // browser-side text reads with recorded results — the app's user-facing messages
  { type: 'before', callId: 'call@70', class: 'Frame', method: 'innerText', params: { selector: '[role="alert"] >> nth=0' }, startTime: 1300 },
  { type: 'after', callId: 'call@70', endTime: 1310, result: { value: 'Payment failed — your card was declined.' } },
  { type: 'before', callId: 'call@71', class: 'Frame', method: 'innerText', params: { selector: '[role="alert"] >> nth=0' }, startTime: 1350 },
  { type: 'after', callId: 'call@71', endTime: 1360, result: { value: 'Payment failed — your card was declined.' } },   // duplicate → folded
  { type: 'before', callId: 'call@72', class: 'Frame', method: 'innerText', params: { selector: '[role="alert"] >> nth=1' }, startTime: 1400 },
  { type: 'after', callId: 'call@72', endTime: 1410, result: { value: '' } },                                            // empty → dropped
  { type: 'before', callId: 'call@73', class: 'Frame', method: 'innerText', params: { selector: '#price-cell' }, startTime: 1450 },
  { type: 'after', callId: 'call@73', endTime: 1460, result: { value: '$9.00' } },                                       // not a message surface → dropped
  { type: 'before', callId: 'call@74', class: 'Frame', method: 'innerText', params: { selector: '[role="dialog"] >> nth=1' }, startTime: 5200 },
  { type: 'after', callId: 'call@74', endTime: 5210, result: { value: 'Confirm upgrade\n\nCHARGED TODAY\n\n$9.67' } },
];
const snapshotRows = [
  { type: 'frame-snapshot', snapshot: { isMainFrame: true, frameUrl: 'about:blank', timestamp: 900, html: ['HTML', {}, ['BODY']] } },
  { type: 'frame-snapshot', snapshot: { isMainFrame: true, frameUrl: 'https://x.test/checkout?q=1#f', timestamp: 1250, html: ['HTML', {}, ['HEAD', {}, ['TITLE', {}, 'Stripe Checkout']], ['BODY', {}, ['H1', {}, 'Pay now']]] } },
  { type: 'frame-snapshot', snapshot: { isMainFrame: false, frameUrl: 'https://x.test/iframe', timestamp: 1260, html: ['HTML', {}, ['HEAD', {}, ['TITLE', {}, 'iframe title']]] } },
  { type: 'frame-snapshot', snapshot: { isMainFrame: true, frameUrl: 'https://x.test/admin', timestamp: 5200, html: ['HTML', {}, ['HEAD', {}, ['TITLE', {}, 'Admin']], ['BODY', {}, ['H1', {}, 'my-substrate']]] } },
];
const text = J([...rows, ...messageRows, ...snapshotRows]);

test('safeTitle masks values typed into sensitive selectors, keeps others', () => {
  assert.equal(safeTitle('Type "4242424242424242" locator(\'#cardNumber\')', { selector: '#cardNumber', text: '4242424242424242' }),
    'Type "•••" locator(\'#cardNumber\')');
  assert.equal(safeTitle('Fill "Jane Doe" locator(\'#billingName\')', { selector: '#billingName', value: 'Jane Doe' }),
    'Fill "Jane Doe" locator(\'#billingName\')');
});

test('parseTraceSpans carries class/params/stepId', () => {
  const s = parseTraceSpans(text).find((x) => x.callId === 'call@90');
  assert.equal(s.cls, 'Frame'); assert.equal(s.stepId, 'expect@4');
  assert.equal(s.params.expression, 'to.be.enabled');
});

test('tileChapters covers the clip: 0 → next.start → totalMs', () => {
  const ch = tileChapters([
    { startMs: 100, endMs: 200 }, { startMs: 4000, endMs: 4100 },
  ], 9000);
  assert.equal(ch[0].startMs, 0); assert.equal(ch[0].endMs, 4000);
  assert.equal(ch[1].endMs, 9000);
});

test('checksFromSpans joins runner expect with browser twin via stepId', () => {
  const spans = parseTraceSpans(text);
  const checks = checksFromSpans(spans, traceT0(spans));
  const enabled = checks.find((k) => k.title === 'toBeEnabled');
  assert.ok(enabled, 'generic Expect title normalised');
  assert.equal(enabled.selector, 'testid=submit-button');
  const msg = checks.find((k) => k.title === 'checkout did not return a hosted url');
  assert.equal(msg.expected, 'checkout.stripe.com');
});

test('attachChecks buckets checks into windows; mined checks never touch assertions', () => {
  const spans = parseTraceSpans(text);
  const t0 = traceT0(spans);
  const chapters = tileChapters(chaptersFromTrace(spans, t0), 6000);
  const withChecks = attachChecks(chapters, checksFromSpans(spans, t0));
  assert.equal(withChecks[0].checks.length, 1);           // toBeEnabled at 500
  assert.equal(withChecks[1].checks.length, 1);           // hosted-url at 4500
  for (const c of withChecks) assert.deepEqual(c.assertions, []);
});

test('attachChecks folds identical poll re-checks into one entry with a count', () => {
  const chapters = [{ startMs: 0, endMs: 10000 }];
  const invariant = (atMs) => ({ atMs, title: 'dest never went running on a new slug', expected: 'tidal-layer' });
  const checks = [invariant(100), { atMs: 150, title: 'status is migrating' }, invariant(1100),
    invariant(2100), { atMs: 2150, title: 'status is migrating' }, invariant(3100)];
  const [c] = attachChecks(chapters, checks);
  assert.equal(c.checks.length, 2, 'two DISTINCT claims survive');
  const inv = c.checks.find((k) => k.title.startsWith('dest never'));
  assert.equal(inv.count, 4, 'poll repeats folded into a count');
  assert.equal(inv.atMs, 100, 'first occurrence kept for highlighting');
  assert.equal(inv.lastMs, 3100, 'last occurrence recorded');
  assert.equal(c.checks.find((k) => k.title === 'status is migrating').count, 2);
});

test('parseSnapshots keeps only resolvable main-frame shots, strips query/fragment', () => {
  const shots = parseSnapshots(text);
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map((s) => s.pageTitle), ['Stripe Checkout', 'Admin']);
  assert.equal(shots[0].url, 'https://x.test/checkout');
  assert.equal(shots[1].heading, 'my-substrate');
});

test('attachSees gives each chapter the last shot before its window ends', () => {
  const spans = parseTraceSpans(text);
  const t0 = traceT0(spans);
  const chapters = tileChapters(chaptersFromTrace(spans, t0), 6000);
  const seen = attachSees(chapters, parseSnapshots(text), t0);
  assert.equal(seen[0].sees.pageTitle, 'Stripe Checkout');
  assert.equal(seen[1].sees.pageTitle, 'Admin');
  assert.equal(seen[1].sees.heading, 'my-substrate');
});

test('chaptersWithActions end-to-end: tiled, actions with selector/value, masked card', () => {
  const { chapters } = chaptersWithActions(text);
  assert.equal(chapters.length, 2);                        // two navigations = two beats
  assert.equal(chapters[0].startMs, 0);
  assert.equal(chapters[0].endMs, chapters[1].startMs);    // tiled — no gap
  const typing = chapters[0].actions.find((a) => a.selector === '#cardNumber');
  assert.equal(typing.value, '•••');
  assert.ok(typing.title.includes('•••') && !typing.title.includes('4242'));
  const fill = chapters[0].actions.find((a) => a.selector === '#billingName');
  assert.equal(fill.value, 'Jane Doe');
  const nav = chapters[0].actions.find((a) => a.kind === 'navigate');
  assert.equal(nav.url, 'https://x.test/checkout');        // fragment stripped
  assert.equal(chapters[0].checks.length, 1);
  assert.equal(chapters[0].sees.pageTitle, 'Stripe Checkout');
});

test('messagesFromSpans keeps message-surface reads, folds dupes, drops empties and non-messages', () => {
  const spans = parseTraceSpans(text);
  const msgs = messagesFromSpans(spans, traceT0(spans));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, 'Payment failed — your card was declined.');
  assert.equal(msgs[0].atMs, 300);
  assert.equal(msgs[1].text, 'Confirm upgrade CHARGED TODAY $9.67');   // newlines collapsed
  assert.ok(!msgs.some((m) => m.text === '$9.00'), 'plain text reads are not messages');
});

test('attachMessages buckets messages into tiled windows; chaptersWithActions carries them', () => {
  const spans = parseTraceSpans(text);
  const t0 = traceT0(spans);
  const tiled = tileChapters(chaptersFromTrace(spans, t0), 6000);
  const withMsgs = attachMessages(tiled, messagesFromSpans(spans, t0));
  assert.equal(withMsgs[0].messages.length, 1);
  assert.equal(withMsgs[1].messages.length, 1);
  const { chapters } = chaptersWithActions(text);
  assert.equal(chapters[0].messages[0].text, 'Payment failed — your card was declined.');
});

test('post-test step: trace tail beyond the video becomes an explicit final chapter', () => {
  // spans end at 4510 (trace clock, rebased); pretend the video stopped at 2.5s
  const { chapters } = chaptersWithActions(text, { videoMs: 2500 });
  const postStep = chapters[chapters.length - 1];
  assert.equal(postStep.post, true);
  assert.equal(postStep.startMs, 2500);
  assert.equal(postStep.endMs, 4510);
  assert.ok(postStep.checks.some((k) => k.title === 'checkout did not return a hosted url'), 'teardown check lives in the post step');
  assert.ok(postStep.messages.some((m) => m.text.startsWith('Confirm upgrade')), 'post-video message captured there too');
  const visible = chapters.slice(0, -1);
  assert.equal(visible[visible.length - 1].endMs, 2500, 'visible chapters tile exactly to the video');
  assert.ok(visible.every((c) => !c.post));
  // windows are disjoint — nothing double-buckets
  const all = chapters.flatMap((c) => (c.checks || []).map((k) => k.title + '@' + k.atMs));
  assert.equal(new Set(all).size, all.length, 'no check appears in two steps');
  // without videoMs: behaviour unchanged, no post chapter
  assert.ok(!chaptersWithActions(text).chapters.some((c) => c.post));
});

test('prettySelector extracts testids and truncates monsters', () => {
  assert.equal(prettySelector('internal:testid=[data-testid="confirm-upgrade"s]'), 'testid=confirm-upgrade');
  assert.equal(prettySelector('x'.repeat(100)).length, 78); // 77 chars + ellipsis
});

test('attachActions untouched contract: still buckets by window (existing callers)', () => {
  const spans = parseTraceSpans(text);
  const t0 = traceT0(spans);
  const raw = chaptersFromTrace(spans, t0);                // untiled navigation beats
  const ch = attachActions(raw, spans, t0);
  assert.ok(Array.isArray(ch[0].actions));
});
