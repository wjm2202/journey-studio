// enrich — PURE: turn a Playwright network trace into per-chapter "downstream" API calls.
// No fs, no unzip, no network access. The CLI reads trace.zip + openapi.json and calls
// enrichGuide(); everything here is a deterministic transform over plain data.
//
// SAFETY (Ground Rule adjacent): scrubUrl() runs on every call BEFORE it is grouped,
// joined, or written. v1 downstream[] INTENTIONALLY carries NO request/response bodies
// and NO headers — only method, a redacted path, status, timing, and the OpenAPI meaning.
// Bodies are the highest-risk secret surface and add little beyond the operation summary;
// they can be added later behind the same scrubber if narration ever needs them.

const SECRET_QUERY =
  /^(token|key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|sig|signature|code|state)$/i;

// Whole-value secret patterns — redacted wherever they appear (defence in depth for the path).
const SECRET_VALUE = [
  /mmk_[A-Za-z0-9]{6,}/g,                                  // MMPM API keys (legacy format)
  /mmpm_(?:live|test)_[A-Za-z0-9]{6,}/g,                   // MMPM API keys (current format)
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,   // JWTs (header.payload.sig)
  /sk-[A-Za-z0-9]{16,}/g,                                  // sk- style secrets
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                           // GitHub tokens
];
const REDACTED = '[REDACTED]';

function redactValue(str) {
  let s = String(str);
  for (const re of SECRET_VALUE) s = s.replace(re, REDACTED);
  return s;
}

/** Redact whole-value secret patterns from any free text (console messages, etc.). */
export function scrubText(s) { return redactValue(s); }

/** Redact secrets from a raw URL: whole-value token patterns + known secret query params. */
export function scrubUrl(url) {
  const raw = redactValue(url);
  const qi = raw.indexOf('?');
  if (qi === -1) return raw;
  const base = raw.slice(0, qi);
  const params = raw.slice(qi + 1).split('&').map((kv) => {
    const eq = kv.indexOf('=');
    if (eq === -1) return kv;
    const k = kv.slice(0, eq);
    let name; try { name = decodeURIComponent(k); } catch { name = k; }
    return SECRET_QUERY.test(name) ? `${k}=${REDACTED}` : kv;
  });
  return `${base}?${params.join('&')}`;
}

/** Parse a Playwright `*.network` JSONL blob into HAR-ish entries.
 *  Tolerates blank/non-JSON lines and both `{type:'resource-snapshot',snapshot}` and
 *  bare-entry framings. Only entries with a request URL survive. */
export function parseNetworkLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const entry = obj && obj.type === 'resource-snapshot' ? obj.snapshot : obj;
    if (entry && entry.request && entry.request.url) out.push(entry);
  }
  return out;
}

/** Best-effort monotonic timestamp (ms) for an entry: Playwright's `_monotonicTime`,
 *  else the ISO `startedDateTime`. Returns null when neither is present. */
export function entryTimeMs(entry) {
  if (typeof entry._monotonicTime === 'number') return entry._monotonicTime;
  if (entry.startedDateTime) {
    const t = Date.parse(entry.startedDateTime); // static string parse — no wall clock
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/** Origin for the trace clock = earliest timestamp across entries (0 if none). */
export function traceStartMs(entries) {
  const times = entries.map(entryTimeMs).filter((t) => t != null);
  return times.length ? Math.min(...times) : 0;
}

/** Pathname of a URL, tolerant of unparseable inputs. */
export function pathOf(url) {
  try { return new URL(url).pathname; }
  catch {
    const m = /^[a-z]+:\/\/[^/]+(\/[^?#]*)/i.exec(url);
    return m ? m[1] : url;
  }
}

/** One HAR entry -> a normalized, scrubbed call. `startMs` is the trace clock origin. */
export function normalizeCall(entry, startMs = 0) {
  const url = scrubUrl(entry.request.url);
  const at = entryTimeMs(entry);
  return {
    atMs: at == null ? null : Math.max(0, Math.round(at - startMs)),
    method: (entry.request.method || 'GET').toUpperCase(),
    url,
    path: pathOf(url),
    status: entry.response && typeof entry.response.status === 'number' ? entry.response.status : null,
    durationMs: typeof entry.time === 'number' ? Math.round(entry.time) : null,
  };
}

/** Compile the OpenAPI spec into a fast method+path matcher list. */
export function buildApiIndex(spec) {
  const out = [];
  for (const [tpl, ops] of Object.entries((spec && spec.paths) || {})) {
    const re = new RegExp(
      '^' +
        tpl.split('/').map((seg) =>
          /^\{.*\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        ).join('/') +
        '/?$',
    );
    for (const [method, op] of Object.entries(ops || {})) {
      if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
      out.push({
        method: method.toUpperCase(), re, tpl,
        summary: (op && op.summary) || null,
        tags: (op && op.tags) || [],
        operationId: (op && op.operationId) || null,
      });
    }
  }
  return out;
}

/** Match a call to an OpenAPI operation, or null. */
export function joinOpenApi(call, index) {
  const hit = index.find((e) => e.method === call.method && e.re.test(call.path));
  if (!hit) return null;
  return { summary: hit.summary, tag: hit.tags[0] || null, operationId: hit.operationId, template: hit.tpl };
}

/** Assign each call to the chapter whose [startMs,endMs) window contains it.
 *  Before the first window -> first chapter; after the last -> last chapter;
 *  calls with no timestamp are dropped (can't be placed). */
export function groupByChapter(calls, chapters) {
  const buckets = (chapters || []).map(() => []);
  if (!chapters || !chapters.length) return buckets;
  for (const c of calls) {
    if (c.atMs == null) continue;
    let idx = chapters.findIndex((ch) => c.atMs >= ch.startMs && c.atMs < ch.endMs);
    if (idx === -1) idx = c.atMs < chapters[0].startMs ? 0 : chapters.length - 1;
    buckets[idx].push(c);
  }
  return buckets;
}

/** Orchestrator: return a NEW guide with steps[].downstream filled from the trace.
 *  Static assets are dropped — a call survives only if it matches the OpenAPI spec
 *  or its path contains '/api/'. Pure: no fs, no mutation of the input guide. */
export function enrichGuide(guide, { networkText = '', startMs, openapi } = {}) {
  const entries = parseNetworkLines(networkText);
  const t0 = startMs == null ? traceStartMs(entries) : startMs;
  const index = openapi ? buildApiIndex(openapi) : [];

  const calls = entries
    .map((e) => ({ c: normalizeCall(e, t0) }))
    .map(({ c }) => ({ c, api: joinOpenApi(c, index) }))
    .filter(({ c, api }) => api || c.path.includes('/api/')) // drop static assets / noise
    .map(({ c, api }) => ({
      atMs: c.atMs, method: c.method, path: c.path, status: c.status, durationMs: c.durationMs,
      summary: api ? api.summary : null, tag: api ? api.tag : null, operationId: api ? api.operationId : null,
    }))
    .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));

  const steps = guide.steps || [];
  const buckets = groupByChapter(calls, steps);
  const nextSteps = steps.map((s, i) => ({ ...s, downstream: buckets[i] || [] }));

  return { ...guide, steps: nextSteps };
}

/** Summary stats for CLI logging — how many calls, and per tag. Pure. */
export function enrichStats(guide) {
  const all = (guide.steps || []).flatMap((s) => s.downstream || []);
  const byTag = {};
  for (const d of all) { const k = d.tag || '(unmatched)'; byTag[k] = (byTag[k] || 0) + 1; }
  return { total: all.length, byTag };
}
