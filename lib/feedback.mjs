// feedback — PURE note model for the "work to do" loop. No fs; the server reads/writes
// guides/feedback.json and calls these to add / update / remove / summarize notes.
import { createHash } from 'node:crypto';

export const TAGS = ['fix', 'rename', 're-record', 'question', 'idea', 'baseline'];

export function noteId(seedParts) {
  return 'n_' + createHash('sha1').update(seedParts.join(' ')).digest('hex').slice(0, 12);
}

export function newNote({ batch, slug, stepIndex = null, step = null, tag = 'fix', text = '', now = '' }) {
  const t = TAGS.includes(tag) ? tag : 'fix';
  return {
    id: noteId([batch, slug, String(stepIndex), now, text]),
    batch: batch || null, slug: slug || null, stepIndex: stepIndex == null ? null : Number(stepIndex),
    step: step || null, tag: t, text: String(text || '').slice(0, 2000),
    status: 'open', createdAt: now, updatedAt: now,
  };
}
export function addNote(list, note) { return [...(list || []), note]; }
export function updateNote(list, id, patch, now = '') {
  return (list || []).map((n) => (n.id === id ? { ...n, ...patch, updatedAt: now || n.updatedAt } : n));
}
export function removeNote(list, id) { return (list || []).filter((n) => n.id !== id); }
export function summarize(list) {
  const notes = list || [];
  const byJourney = {};
  let open = 0, done = 0;
  for (const n of notes) {
    if (n.status === 'done') done++; else open++;
    if (n.status !== 'done' && n.batch && n.slug) { const k = `${n.batch}/${n.slug}`; byJourney[k] = (byJourney[k] || 0) + 1; }
  }
  return { total: notes.length, open, done, openByJourney: byJourney };
}
