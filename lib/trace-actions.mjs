// trace-actions — PURE: parse a Playwright `*.trace` (JSONL) into action spans, then
// derive video-aligned chapters (the human-authored `test.step` beats) with the UI
// actions (`pw:api`) that happened inside each. No fs, no unzip — the caller passes text.
//
// This is what grounds a guide when the JSON report carries no test.step chapters:
// the trace still has them, plus every click/navigation/API call with a timestamp on
// the same monotonic clock as the network log — so steps, actions, and downstream all
// line up on one timeline that matches the video.
//
// Two streams share that clock: the RUNNER trace (class 'Test' — pw:api / expect /
// test.step rows with human titles + real params) and the BROWSER trace (class
// 'Frame'/'Page' — expect rows carrying the matcher expression, linked back to the
// runner row via stepId; frame-snapshot rows carrying the page HTML). We mine both.
import { scrubText } from './enrich.mjs';

/** Pair before/after events by callId into spans:
 *  {callId, apiName, title, startTime, endTime, cls, params, stepId}. */
export function parseTraceSpans(text) {
  const before = new Map();
  const spans = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.type === 'before') before.set(o.callId, o);
    else if (o.type === 'after') {
      const b = before.get(o.callId);
      if (b) spans.push({
        callId: o.callId, apiName: b.method ?? b.apiName, title: String(b.title || ''),
        startTime: b.startTime, endTime: o.endTime ?? b.startTime,
        cls: b.class ?? null, params: b.params ?? null, stepId: b.stepId ?? null,
        result: o.result ?? null,
      });
    }
  }
  spans.sort((a, b) => a.startTime - b.startTime);
  return spans;
}

// ── secret hygiene for mined text ──
// Values typed into sensitive fields (cards, secrets, passwords) appear verbatim in
// runner titles like `Type "4242…" locator('#cardNumber')` — mask them; scrub the rest.
const SENSITIVE_SELECTOR = /card|cvc|cvv|password|passwd|secret|token|otp|api[-_]?key/i;
const MASK = '•••';

/** Mask the quoted typed value in an action title when its selector is sensitive,
 *  then run the standard secret scrubber. */
export function safeTitle(title, params) {
  let t = String(title || '');
  const sel = params && params.selector;
  const val = params && (params.text ?? params.value);
  if (sel && val && SENSITIVE_SELECTOR.test(String(sel))) t = t.split(String(val)).join(MASK);
  return scrubText(t);
}

/** Trace clock origin = earliest span start (0 if none). */
export function traceT0(spans) {
  return spans.length ? Math.min(...spans.map((s) => s.startTime)) : 0;
}

/** The video's real t=0 ≈ when Playwright created the context/page (recording start).
 *  Using this instead of the first setup hook keeps chapters aligned to the video even
 *  when beforeAll/login runs for seconds before the page exists. Falls back to traceT0. */
export function videoT0(spans) {
  const c = spans.find((s) => s.apiName === 'pw:api' && /create (context|page)/i.test(s.title));
  return c ? c.startTime : traceT0(spans);
}

/** Keep only the OUTERMOST test.step spans (drop steps nested inside another step). */
function topLevelSteps(spans) {
  const steps = spans.filter((s) => s.apiName === 'test.step');
  return steps.filter((s) => !steps.some((o) => o !== s && o.startTime <= s.startTime && o.endTime >= s.endTime && (o.startTime < s.startTime || o.endTime > s.endTime)));
}

/** Fallback when a test authored no steps: use navigations as the beats. */
function navBeats(spans) {
  return spans.filter((s) => s.apiName === 'pw:api' && /^(navigate|goto|go to)\b/i.test(s.title));
}

const clean = (t) => String(t).replace(/^\d+[.)]\s*/, '').trim(); // drop leading "1. "

/** Chapters from the trace, rebased to t0 (video time). Prefers test.step beats;
 *  falls back to navigations; else one whole-clip chapter. */
export function chaptersFromTrace(spans, t0) {
  let src = topLevelSteps(spans);
  if (!src.length) src = navBeats(spans);
  if (!src.length) {
    const end = spans.length ? Math.max(...spans.map((s) => s.endTime)) : t0;
    return [{ id: 's01', index: 1, title: 'Full journey', hint: null, testId: null, startMs: 0, endMs: Math.round(end - t0), assertions: [], actions: [] }];
  }
  src.sort((a, b) => a.startTime - b.startTime);
  return src.map((s, i) => ({
    id: 's' + String(i + 1).padStart(2, '0'), index: i + 1,
    title: scrubText(clean(s.title)) || `Step ${i + 1}`, hint: null, testId: null,
    startMs: Math.max(0, Math.round(s.startTime - t0)),
    endMs: Math.max(0, Math.round(s.endTime - t0)),
    assertions: [], actions: [],
  }));
}

/** Tile chapter windows so they cover the whole clip with no gaps: the first starts
 *  at 0, each ends where the next begins, the last extends to `totalMs`. Beats from
 *  navigations are short spans with long holes between them — the interesting work
 *  (polling, provisioning) happens IN the holes, and actions/downstream/console are
 *  bucketed by window, so untiled chapters mis-attribute all of it. Returns NEW
 *  chapters; endMs is clamped so windows stay non-negative. */
export function tileChapters(chapters, totalMs = 0) {
  const n = (chapters || []).length;
  return (chapters || []).map((c, i) => ({
    ...c,
    startMs: i === 0 ? 0 : c.startMs,
    endMs: i < n - 1 ? Math.max(chapters[i + 1].startMs, c.startMs) : Math.max(c.endMs, totalMs, c.startMs),
  }));
}

/** True for spans that are meaningful UI/API actions worth showing as cause→effect.
 *  Mechanical probes (visibility peeks, inner-text reads, evaluate, screenshots,
 *  teardown) are the test LOOKING, not the user DOING — they drown the teleprompter. */
function isAction(s) {
  if (s.apiName !== 'pw:api') return false;
  return !/^(create (context|page)|add cookies|query count|wait for|is (visible|enabled|checked|hidden)|get (inner text|text content|attribute|bounding box)|text content|evaluate|screenshot|close context|close page)/i.test(s.title);
}

/** Attach each chapter's UI actions (pw:api) by time window. Returns NEW chapters.
 *  Actions carry the real selector / typed value / target URL from the runner params
 *  (sensitive values masked, secrets scrubbed) — "click WHAT, type WHAT" for the
 *  teleprompter and the narration brief, not just a title string. */
export function attachActions(chapters, spans, t0) {
  const acts = spans.filter(isAction).map((s) => {
    const p = s.params || {};
    const sensitive = p.selector && SENSITIVE_SELECTOR.test(String(p.selector));
    const val = p.text ?? p.value;
    const a = { title: safeTitle(clean(s.title), p), atMs: Math.max(0, Math.round(s.startTime - t0)), kind: actionKind(s.title) };
    if (p.selector) a.selector = String(p.selector);
    if (val != null && typeof val !== 'object') a.value = sensitive ? '•••' : scrubText(String(val));
    if (a.kind === 'navigate' && p.url && typeof p.url === 'string') a.url = scrubText(p.url.split('#')[0]);
    return a;
  });
  return chapters.map((c) => ({ ...c, actions: acts.filter((a) => a.atMs >= c.startMs && a.atMs < c.endMs) }));
}

// ── assertions mined from the trace ──
// Runner-side expect rows have the human title (custom message or `Expect "toBeX"`);
// the browser-side twin (joined via stepId === runner callId) adds the matcher
// expression, the selector, and isNot. Basic guides get their "what this proves"
// lines from here. Mined checks live in step.checks — NEVER step.assertions, which
// stays the author-declared list that feeds the journey fingerprint.
export function checksFromSpans(spans, t0) {
  const browser = new Map();
  for (const s of spans) {
    if (s.apiName === 'expect' && s.cls !== 'Test' && s.stepId) browser.set(s.stepId, s);
  }
  const runner = spans.filter((s) => s.apiName === 'expect' && s.cls === 'Test');
  const src = runner.length ? runner : spans.filter((s) => s.apiName === 'expect' && s.cls !== 'Test');
  return src.map((s) => {
    const twin = s.cls === 'Test' ? browser.get(s.callId) : s;
    const p = (twin && twin.params) || s.params || {};
    const generic = /^Expect "(.+)"$/.exec(String(s.title || ''));
    const check = {
      atMs: Math.max(0, Math.round(s.startTime - t0)),
      title: scrubText(generic ? (p.isNot ? 'not ' : '') + generic[1] : clean(s.title)),
    };
    if (p.selector) check.selector = prettySelector(p.selector);
    if (p.expression && generic == null) check.expression = String(p.expression);
    const exp = s.params && s.params.expected;
    if (exp != null && exp !== 'Object' && typeof exp !== 'object') check.expected = scrubText(String(exp));
    return check;
  });
}

/** Human-readable form of Playwright's internal selector syntax. */
export function prettySelector(sel) {
  const s = String(sel);
  const tid = /internal:testid=\[data-testid="([^"]+)"s?\]/.exec(s);
  if (tid) return `testid=${tid[1]}`;
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

/** Bucket mined checks into chapter windows, FOLDING identical repeats: a polling
 *  loop that re-asserts the same invariant every tick (e.g. "dest never went
 *  running" ×34) becomes ONE check with a count — the claim is what matters, the
 *  repetition is just the poll cadence. atMs keeps the FIRST occurrence (for
 *  time-highlighting), lastMs the final one. Returns NEW chapters with .checks. */
export function attachChecks(chapters, checks) {
  return chapters.map((c) => {
    const by = new Map();
    for (const k of (checks || []).filter((x) => x.atMs >= c.startMs && x.atMs < c.endMs)) {
      const key = `${k.title}|${k.selector || ''}|${k.expected ?? ''}`;
      const prev = by.get(key);
      if (prev) { prev.count++; prev.lastMs = k.atMs; }
      else by.set(key, { ...k, count: 1, lastMs: k.atMs });
    }
    return { ...c, checks: [...by.values()] };
  });
}

// ── user messaging: what the app TOLD the user, mined from text-read results ──
// Tests read the UI's message surfaces (role=alert/status/dialog, toasts, banners)
// via innerText/textContent, and the BROWSER trace records each call's RESULT —
// the exact message shown, on the video clock. That's the app's side of the
// conversation with the user, and the narrator should see it per step.
const MESSAGE_SELECTOR = /alert|status|dialog|toast|banner|snackbar|notif|error|warning|message/i;
const MSG_MAX = 240;

/** Normalize a mined message: whitespace collapsed, scrubbed, capped. */
function msgText(v) {
  const t = scrubText(String(v).replace(/\s+/g, ' ').trim());
  return t.length > MSG_MAX ? t.slice(0, MSG_MAX - 1) + '…' : t;
}

/** Extract user-facing messages: browser-side innerText/textContent reads on
 *  message-y selectors with a non-empty result. Consecutive duplicates folded. */
export function messagesFromSpans(spans, t0) {
  const out = [];
  for (const s of spans) {
    if (s.cls === 'Test') continue;
    if (s.apiName !== 'innerText' && s.apiName !== 'textContent') continue;
    const sel = s.params && s.params.selector ? String(s.params.selector) : '';
    if (!MESSAGE_SELECTOR.test(sel)) continue;
    const v = s.result && typeof s.result.value === 'string' ? s.result.value.trim() : '';
    if (!v) continue;
    const m = { atMs: Math.max(0, Math.round(s.startTime - t0)), selector: prettySelector(sel), text: msgText(v) };
    const last = out[out.length - 1];
    if (last && last.selector === m.selector && last.text === m.text) continue;
    out.push(m);
  }
  return out;
}

/** Bucket messages into chapter windows. Returns NEW chapters with .messages. */
export function attachMessages(chapters, messages) {
  return chapters.map((c) => ({ ...c, messages: (messages || []).filter((m) => m.atMs >= c.startMs && m.atMs < c.endMs) }));
}

// ── what the viewer sees: page title + heading from frame snapshots ──

function snapText(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    const ch = node.length > 1 && typeof node[1] === 'object' && !Array.isArray(node[1]) ? node.slice(2) : node.slice(1);
    return ch.map(snapText).join('');
  }
  return '';
}
function snapFind(node, tag) {
  if (Array.isArray(node) && typeof node[0] === 'string') {
    if (node[0].toUpperCase() === tag) return snapText(node).trim();
    const ch = node.length > 1 && typeof node[1] === 'object' && !Array.isArray(node[1]) ? node.slice(2) : node.slice(1);
    for (const c of ch) { const r = snapFind(c, tag); if (r != null) return r; }
  } else if (Array.isArray(node)) {
    for (const c of node) { const r = snapFind(c, tag); if (r != null) return r; }
  }
  return null;
}

/** Parse main-frame snapshots out of raw trace text: [{time, url, pageTitle, heading}].
 *  Delta snapshots that reference earlier DOM (no resolvable TITLE) are skipped. */
export function parseSnapshots(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.indexOf('"frame-snapshot"') === -1) continue;
    let o; try { o = JSON.parse(line.trim()); } catch { continue; }
    if (o.type !== 'frame-snapshot') continue;
    const s = o.snapshot ?? o;
    if (!s.isMainFrame || !s.html) continue;
    const url = String(s.frameUrl || '');
    if (!url || url === 'about:blank') continue;
    const pageTitle = snapFind(s.html, 'TITLE');
    const heading = snapFind(s.html, 'H1');
    if (!pageTitle && !heading) continue;
    out.push({ time: s.timestamp, url: scrubText(url.split(/[?#]/)[0]), pageTitle: pageTitle ? scrubText(pageTitle) : null, heading: heading ? scrubText(heading) : null });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Give each chapter the LAST resolvable snapshot inside (or before the end of) its
 *  window — where the step visually ends up. Returns NEW chapters with .sees. */
export function attachSees(chapters, shots, t0) {
  const rel = (shots || []).map((s) => ({ ...s, atMs: Math.max(0, Math.round(s.time - t0)) }));
  return chapters.map((c) => {
    let hit = null;
    for (const s of rel) { if (s.atMs < c.endMs) hit = s; else break; }
    return { ...c, sees: hit ? { url: hit.url, pageTitle: hit.pageTitle, heading: hit.heading } : null };
  });
}

function actionKind(title) {
  if (/^navigat|^go ?to/i.test(title)) return 'navigate';
  if (/^(GET|POST|PUT|PATCH|DELETE)\b/.test(title)) return 'api';
  if (/click|fill|press|check|select|type|hover|set input/i.test(title)) return 'interact';
  return 'action';
}

// ── browser console + page errors ──
const CONSOLE_LEVEL = { error: 'error', assert: 'error', warning: 'warning', warn: 'warning', log: 'log', info: 'info' };

/** Parse console + pageerror events from raw trace text (standalone JSONL rows). */
export function parseConsole(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.indexOf('"console"') === -1 && line.indexOf('"pageerror"') === -1) continue;
    let o; try { o = JSON.parse(line.trim()); } catch { continue; }
    if (o.type === 'pageerror') {
      const e = o.error || {};
      out.push({ level: 'error', text: String(e.message || e.stack || o.message || 'page error'), url: '', time: o.time });
    } else if (o.type === 'console') {
      const lvl = CONSOLE_LEVEL[o.messageType];
      if (!lvl) continue;
      out.push({ level: lvl, text: String(o.text || ''), url: (o.location && o.location.url) || '', time: o.time });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
function dedupeConsole(list) {
  const out = [];
  for (const e of list) {
    const l = out[out.length - 1];
    if (l && l.level === e.level && l.text === e.text) l.count++;
    else out.push({ ...e, count: 1 });
  }
  return out;
}
/** Bucket console events into chapter windows (rebased to t0), consecutive dupes folded. */
export function attachConsole(chapters, events, t0) {
  const evs = events.map((e) => ({ level: e.level, text: e.text, url: e.url, atMs: Math.max(0, Math.round(e.time - t0)) }));
  return chapters.map((c) => ({ ...c, console: dedupeConsole(evs.filter((e) => e.atMs >= c.startMs && e.atMs < c.endMs)) }));
}

/** One-call convenience: text → {chapters (tiled, with actions + checks + sees +
 *  console), t0}. Chapters are tiled to cover the whole clip BEFORE anything is
 *  bucketed, so work in the gaps between beats is attributed, not dumped at the end.
 *
 *  POST-TEST STEP: the trace clock outruns the recording — teardown verification
 *  (final DB/Stripe reconciliation expects) runs after the video stops. When
 *  opts.videoMs is known and the trace extends >1.5s past it, that tail becomes an
 *  explicit final chapter (post: true) so its checks/calls/messages have a proper
 *  home the narrator can talk over the closing frame — instead of stretching the
 *  last visible step past the video (which also broke its done-state in the UI). */
export function chaptersWithActions(traceText, opts = {}) {
  const spans = parseTraceSpans(traceText);
  const t0 = opts.t0 == null ? videoT0(spans) : opts.t0;
  const traceEnd = spans.length ? Math.max(0, Math.round(Math.max(...spans.map((s) => s.endTime)) - t0)) : 0;
  const videoMs = opts.videoMs > 0 ? Math.round(opts.videoMs) : 0;
  const post = !!videoMs && traceEnd - videoMs > 1500;
  let chapters;
  if (post) {
    // beats that START at/after the video's end belong to the post step, not the tiles
    let base = chaptersFromTrace(spans, t0).filter((c) => c.startMs < videoMs);
    if (!base.length) base = [{ id: 's01', index: 1, title: 'Full journey', hint: null, testId: null, startMs: 0, endMs: videoMs, assertions: [], actions: [] }];
    chapters = tileChapters(base, videoMs)
      .map((c, i, a) => (i === a.length - 1 ? { ...c, endMs: Math.max(c.startMs, Math.min(c.endMs, videoMs)) } : c));
    chapters = [...chapters, {
      id: 's' + String(chapters.length + 1).padStart(2, '0'), index: chapters.length + 1,
      title: 'Post-test verification (after the video ends)', hint: null, testId: null,
      startMs: videoMs, endMs: traceEnd, assertions: [], actions: [], post: true,
    }];
  } else {
    chapters = tileChapters(chaptersFromTrace(spans, t0), traceEnd);
  }
  chapters = attachActions(chapters, spans, t0);
  chapters = attachChecks(chapters, checksFromSpans(spans, t0));
  chapters = attachMessages(chapters, messagesFromSpans(spans, t0));
  chapters = attachSees(chapters, parseSnapshots(traceText), t0);
  chapters = attachConsole(chapters, parseConsole(traceText), t0);
  return { chapters, t0, spanCount: spans.length };
}
