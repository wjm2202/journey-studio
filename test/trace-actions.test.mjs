import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTraceSpans, traceT0, chaptersFromTrace, attachActions, chaptersWithActions } from '../lib/trace-actions.mjs';

const lines = [
  { type: 'context-options' },
  { type: 'before', callId: 'hook@1', apiName: 'hook', title: 'Before Hooks', startTime: 1000 },
  { type: 'after', callId: 'hook@1', endTime: 1010 },
  { type: 'before', callId: 'step@1', apiName: 'test.step', title: '1. Buy Starter → running', startTime: 1100 },
  { type: 'before', callId: 'api@1', apiName: 'pw:api', title: 'Navigate to "/checkout"', startTime: 1120 },
  { type: 'after', callId: 'api@1', endTime: 1180 },
  { type: 'before', callId: 'api@2', apiName: 'pw:api', title: 'POST "/api/checkout"', startTime: 1200 },
  { type: 'after', callId: 'api@2', endTime: 1400 },
  { type: 'before', callId: 'nested@1', apiName: 'test.step', title: 'inner detail', startTime: 1210 },
  { type: 'after', callId: 'nested@1', endTime: 1220 },
  { type: 'after', callId: 'step@1', endTime: 1500 },
  { type: 'before', callId: 'step@2', apiName: 'test.step', title: '2. Cancel → refunded', startTime: 1600 },
  { type: 'before', callId: 'api@3', apiName: 'pw:api', title: 'Click getByRole("button")', startTime: 1650 },
  { type: 'after', callId: 'api@3', endTime: 1700 },
  { type: 'before', callId: 'noise@1', apiName: 'pw:api', title: 'Query count locator(\'#x\')', startTime: 1660 },
  { type: 'after', callId: 'noise@1', endTime: 1665 },
  { type: 'after', callId: 'step@2', endTime: 2000 },
].map((o) => JSON.stringify(o)).join('\n');

test('parseTraceSpans pairs before/after by callId', () => {
  const s = parseTraceSpans(lines).find((x) => x.callId === 'step@1');
  assert.equal(s.apiName, 'test.step'); assert.equal(s.startTime, 1100); assert.equal(s.endTime, 1500);
});
test('traceT0 is the earliest span start', () => { assert.equal(traceT0(parseTraceSpans(lines)), 1000); });
test('chaptersFromTrace uses top-level test.step beats, rebased, numbering stripped', () => {
  const spans = parseTraceSpans(lines); const ch = chaptersFromTrace(spans, traceT0(spans));
  assert.equal(ch.length, 2);
  assert.equal(ch[0].title, 'Buy Starter → running');
  assert.equal(ch[0].startMs, 100); assert.equal(ch[0].endMs, 500);
  assert.equal(ch[1].title, 'Cancel → refunded');
});
test('attachActions maps pw:api into chapter windows and drops noise', () => {
  const spans = parseTraceSpans(lines); const t0 = traceT0(spans);
  const ch = attachActions(chaptersFromTrace(spans, t0), spans, t0);
  assert.equal(ch[0].actions.length, 2);
  assert.equal(ch[0].actions[0].kind, 'navigate');
  assert.equal(ch[0].actions[1].kind, 'api');
  assert.equal(ch[1].actions.length, 1);
  assert.equal(ch[1].actions[0].kind, 'interact');
});
test('chaptersWithActions convenience', () => {
  const { chapters, t0, spanCount } = chaptersWithActions(lines);
  assert.equal(t0, 1000); assert.ok(spanCount >= 5);
  assert.equal(chapters.length, 2); assert.equal(chapters[0].actions.length, 2);
});
test('fallback: no test.step → one whole-clip chapter', () => {
  const bare = [
    { type: 'before', callId: 'a', apiName: 'pw:api', title: 'Click x', startTime: 500 },
    { type: 'after', callId: 'a', endTime: 600 },
  ].map((o) => JSON.stringify(o)).join('\n');
  assert.equal(chaptersWithActions(bare).chapters[0].title, 'Full journey');
});
