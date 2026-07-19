// brief — PURE: guide bundle -> narration-brief.md, the AI-readable context pack.
// One deterministic markdown file per guide: what the user DOES, what the screen
// SHOWS, what the test VERIFIES, and what happened BEHIND the scenes — everything
// a narrator (human or AI drafting steps[].narration) needs, in one fetch.
// No fs, no clock: same bundle in, same bytes out (diffable, fingerprint-stamped).

import { groupStep, pollIntervalMs, endpointFreq } from './collapse.mjs';

/** Shorten opaque tokens (session ids, hashes) that burn tokens and add nothing. */
export function shortenTokens(s) {
  return String(s).replace(/[A-Za-z0-9_-]{25,}/g, (m) => m.slice(0, 10) + '…');
}

const sec = (ms) => (ms / 1000).toFixed(1) + 's';
const CONSOLE_CAP = 5;

function callLine(c) {
  const bits = [`${c.method} ${shortenTokens(c.path || '')}`];
  if (c.count > 1) bits.push(`×${c.count}`);
  if (c.status != null) bits.push(c.status > 0 ? `→ ${c.status}` : '→ (aborted)');
  if (c.summary) bits.push(`— ${c.summary}`);
  return bits.join(' ');
}

function groupLines(g) {
  if (g.repeats >= 3) {
    const freq = endpointFreq(g.calls);
    const ep = freq[0] ? shortenTokens(freq[0].ep) : shortenTokens(g.title);
    const span = g.ats.length > 1 ? ((g.ats[g.ats.length - 1] - g.ats[0]) / 1000).toFixed(0) : '0';
    const iv = (pollIntervalMs(g.ats) / 1000).toFixed(1);
    const also = freq.slice(1, 3).map((f) => shortenTokens(f.ep)).join(', ');
    return [`- polling ${ep} — ${g.callCount} calls every ~${iv}s over ${span}s (waiting for state to settle${also ? `; also ${also}` : ''})`];
  }
  const head = `- ${g.kind}: ${shortenTokens(g.title)}${g.repeats > 1 ? ` ×${g.repeats}` : ''}`;
  const calls = g.calls.map((c) => `  - ${callLine(c)}`);
  return [head, ...calls];
}

function checkLine(k) {
  const bits = [k.title];
  if (k.selector) bits.push(`[${shortenTokens(k.selector)}]`);
  if (k.expected != null && k.expected !== 'Object') bits.push(`(expected: ${shortenTokens(String(k.expected))})`);
  if (k.count > 1) bits.push(`×${k.count}`);   // same invariant re-checked through a poll
  return '- ' + bits.join(' ');
}

function stepSection(s, i, n) {
  const out = [`## Step ${s.index}/${n} — ${shortenTokens(s.title)}  [${sec(s.startMs)}–${sec(s.endMs)}]`, ''];
  if (s.hint) out.push(`Hint: ${s.hint}`, '');
  if (s.sees && (s.sees.pageTitle || s.sees.heading)) {
    const bits = [s.sees.pageTitle, s.sees.heading ? `“${s.sees.heading}”` : null].filter(Boolean);
    out.push(`On screen: ${bits.join(' — ')}`, '');
  }
  const acts = [];
  for (const a of s.actions || []) {
    const line = `- ${a.kind}: ${shortenTokens(a.title)}`;
    const last = acts[acts.length - 1];
    if (last && last.line === line) last.n++;
    else acts.push({ line, n: 1 });
  }
  if (acts.length) out.push('Does:', ...acts.map((a) => a.line + (a.n > 1 ? ` ×${a.n}` : '')), '');
  const msgs = (s.messages || []).map((m) => `- ${shortenTokens(m.text)}`);
  if (msgs.length) out.push('Tells the user:', ...msgs, '');
  const checks = [
    ...(s.assertions || []).map((t) => `- ${t}`),           // author-declared (fingerprinted)
    ...(s.checks || []).map(checkLine),                      // mined from the trace
  ];
  if (checks.length) out.push('Verifies:', ...checks, '');
  const groups = groupStep(s).map(groupLines).flat();
  if (groups.length) out.push('Behind the scenes:', ...groups, '');
  const con = (s.console || []).slice().sort((a, b) =>
    (a.level === 'error' ? 0 : a.level === 'warning' ? 1 : 2) - (b.level === 'error' ? 0 : b.level === 'warning' ? 1 : 2));
  if (con.length) {
    const shown = con.slice(0, CONSOLE_CAP);
    out.push('Console:', ...shown.map((c) => `- ${c.level}: ${shortenTokens(String(c.text).slice(0, 200))}${c.count > 1 ? ` ×${c.count}` : ''}`));
    if (con.length > CONSOLE_CAP) out.push(`- … ${con.length - CONSOLE_CAP} more line(s)`);
    out.push('');
  }
  if (s.narration) out.push('Narration (current draft):', `> ${s.narration}`, '');
  return out;
}

/** True when a per-spec outcome matches a dashboard filter. */
export function matchesFilter(t, filter) {
  if (filter === 'all' || !filter) return true;
  if (filter === 'passed') return t.outcome === 'passed' || t.outcome === 'flaky';
  return t.outcome === filter;
}

/**
 * AI review pack for a FILTERED slice of a batch — the markdown a reviewer
 * (human or AI) needs in one fetch: run totals, then each matching spec's outcome,
 * error, and links to its guide bundle + narration brief. PURE, deterministic.
 * @param entry an index.json batch entry
 * @param filter 'all' | 'passed' | 'failed' | 'skipped'
 */
export function buildReview(entry, filter = 'all') {
  const r = entry.results || {};
  const out = [
    `# Test review — ${entry.name || entry.id} (${filter})`,
    '',
    `> Machine-generated review pack. Batch \`${entry.id}\`, ingested ${entry.ingestedAt || 'unknown'}.`,
    `> Run totals: ${r.passed ?? '?'} passed · ${r.failed ?? '?'} failed · ${r.skipped ?? '?'} skipped${r.flaky ? ` · ${r.flaky} flaky` : ''}.`,
    '',
  ];
  if (!entry.tests || !entry.tests.length) {
    out.push('_This batch has no per-spec outcome data — re-ingest it with a current Journey Studio._');
    return out.join('\n') + '\n';
  }
  const tests = entry.tests.filter((t) => matchesFilter(t, filter));
  out.push(`Matching "${filter}": ${tests.length} of ${entry.tests.length} spec(s).`, '');
  for (const t of tests) {
    out.push(`## ${t.outcome.toUpperCase()} — ${shortenTokens(t.title)}`, '');
    if (t.file) out.push(`- spec: ${t.file}`);
    if (t.durationMs) out.push(`- duration: ${sec(t.durationMs)}`);
    if (t.slug) out.push(`- bundle: ${entry.id}/${t.slug}/guide.json`, `- brief: ${entry.id}/${t.slug}/narration-brief.md`);
    if (t.error) out.push('', '```', t.error, '```');
    out.push('');
  }
  if (!tests.length) out.push('_No specs match this filter._');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Build the narration brief for one guide bundle.
 * @param bundle the guide.json object
 * @param opts { fingerprint?: string, batch?: string }
 */
export function buildBrief(bundle, opts = {}) {
  const steps = bundle.steps || [];
  const out = [
    `# ${bundle.title || bundle.objective}`,
    '',
    '> Narration brief — machine-generated context pack for this guide. Timings are',
    '> video-relative. Use it to draft one narration line per step (fill',
    '> `steps[].narration` in guide.json); the human voice-over stays the source of truth.',
    '> "Verifies" lines are the test\'s own checkpoint messages — authors write them as',
    '> FAILURE labels ("X failed", "no Y returned"), so a listed line means it did NOT fail.',
    '',
    `- slug: \`${bundle.objective}\``,
    `- category: ${bundle.category || 'uncategorized'}`,
    `- spec: ${bundle.specFile || 'unknown'}`,
    `- duration: ${sec(bundle.durationMs || 0)} · steps: ${steps.length}`,
  ];
  if (opts.batch) out.push(`- batch: ${opts.batch}`);
  if (opts.fingerprint) out.push(`- fingerprint: ${opts.fingerprint}`);
  if (bundle.assumes && bundle.assumes.length) out.push(`- assumes: ${bundle.assumes.join('; ')}`);
  out.push('');
  for (const s of steps) out.push(...stepSection(s, s.index, steps.length));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
