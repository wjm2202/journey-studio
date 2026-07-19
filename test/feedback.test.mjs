import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNote, addNote, updateNote, removeNote, summarize, noteId, TAGS } from '../lib/feedback.mjs';
test('newNote builds open note, clamps unknown tag, stamps clock', () => {
  const n = newNote({ batch: 'compute', slug: 'checkout', stepIndex: 2, step: 'Buy', tag: 'weird', text: 'wrong', now: 't0' });
  assert.equal(n.status, 'open'); assert.equal(n.tag, 'fix'); assert.equal(n.stepIndex, 2); assert.ok(n.id.startsWith('n_'));
});
test('newNote keeps a valid tag', () => { assert.equal(newNote({ batch: 'b', slug: 's', tag: 're-record', now: 't' }).tag, 're-record'); assert.ok(TAGS.includes('idea')); });
test('noteId stable/distinct', () => { assert.equal(noteId(['a','b']), noteId(['a','b'])); assert.notEqual(noteId(['a','b']), noteId(['a','c'])); });
test('addNote immutable append', () => { const a=[]; const b=addNote(a, newNote({batch:'b',slug:'s',now:'t',text:'x'})); assert.equal(a.length,0); assert.equal(b.length,1); });
test('updateNote patches by id, bumps updatedAt, others untouched', () => {
  let l=[]; l=addNote(l,newNote({batch:'b',slug:'s',now:'t1',text:'one'})); l=addNote(l,newNote({batch:'b',slug:'s',now:'t2',text:'two'}));
  const out=updateNote(l,l[0].id,{status:'done'},'t3'); assert.equal(out[0].status,'done'); assert.equal(out[0].updatedAt,'t3'); assert.equal(out[1].status,'open');
});
test('removeNote drops by id', () => { let l=[newNote({batch:'b',slug:'s',now:'t1',text:'a'}),newNote({batch:'b',slug:'s',now:'t2',text:'b'})]; const out=removeNote(l,l[0].id); assert.equal(out.length,1); assert.equal(out[0].text,'b'); });
test('summarize counts open/done and open-per-journey', () => {
  let l=[]; l=addNote(l,newNote({batch:'compute',slug:'checkout',now:'t1',text:'a'})); l=addNote(l,newNote({batch:'compute',slug:'checkout',now:'t2',text:'b'})); l=addNote(l,newNote({batch:'compute',slug:'upgrade',now:'t3',text:'c'}));
  l=updateNote(l,l[1].id,{status:'done'},'t4'); const s=summarize(l);
  assert.equal(s.total,3); assert.equal(s.open,2); assert.equal(s.done,1); assert.equal(s.openByJourney['compute/checkout'],1); assert.equal(s.openByJourney['compute/upgrade'],1);
});
