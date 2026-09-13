import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageAssembler } from '../lib/message-assembler.js';
import { startsBoostLine } from '../podcast-tags.js';

// The pipe-delimited line this bot reads, in the shape CLAUDE.md documents:
//   "<amount> sats from <sender> via <App> | <fields…> | <comment>"
//
// IRC cuts a long one across lines, and the cut is a character count -- the tail
// arrives with no pipes in it at all, which is exactly the input _formatV4VMessage
// gives up on (`parts.length < 2`) and publishes raw.
const HEAD = '123 sats from mattfinlay@fountain.fm via Fountain | Summer Shorts Edition 2 | Every time a new surprise | "Give Spotify my hard-earned money, or ke';
const TAIP = 'ep it in the ecosystem? Two For Tunestr? 🤔"';
const WHOLE = HEAD + TAIP;

const SECOND = '500 sats from ericpp@fountain.fm via Fountain | 99 - Lightning Thrashes | "nice set"';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function harness(options = {}) {
  const messages = [];
  let timers = [];
  let nextId = 1;

  const assembler = new MessageAssembler({
    isStart: (line) => startsBoostLine(line),
    onMessage: (text, meta) => { messages.push({ text, meta }); },
    logger: silentLogger,
    setTimer: (fn) => { const id = nextId++; timers.push({ id, fn }); return id; },
    clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
    ...options,
  });

  return {
    assembler,
    messages,
    texts: () => messages.map((m) => m.text),
    tick() { const due = timers; timers = []; due.forEach((t) => t.fn()); },
    armed: () => timers.length,
  };
}

test('a boost split across two IRC lines becomes one message', () => {
  const h = harness();
  h.assembler.push(HEAD);
  h.assembler.push(TAIP);
  assert.equal(h.messages.length, 0);

  h.tick();

  assert.equal(h.messages.length, 1);
  assert.equal(h.texts()[0], WHOLE);
  assert.equal(h.messages[0].meta.fragments, 2);
});

test('the rejoined line still splits into the fields the formatter reads', () => {
  const h = harness();
  h.assembler.push(HEAD);
  h.assembler.push(TAIP);
  h.tick();

  const parts = h.texts()[0].split(' | ');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], '123 sats from mattfinlay@fountain.fm via Fountain');
  assert.match(parts[parts.length - 1], /Two For Tunestr\? 🤔"$/, 'the comment arrives whole');
});

test('a second boost closes the first immediately', () => {
  const h = harness();
  h.assembler.push(HEAD);
  h.assembler.push(SECOND);

  assert.equal(h.messages.length, 1);
  assert.equal(h.texts()[0], HEAD);

  h.tick();
  assert.deepEqual(h.texts(), [HEAD, SECOND]);
});

test('a line that is not a boost and continues nothing publishes alone, as before', () => {
  const h = harness();
  h.assembler.push('back in 10');

  assert.equal(h.texts()[0], 'back in 10');
  assert.equal(h.armed(), 0);
});

test('startsBoostLine takes the head and leaves the tail', () => {
  assert.equal(startsBoostLine(HEAD), true);
  assert.equal(startsBoostLine(SECOND), true);
  assert.equal(startsBoostLine('⚡ 21 sats from a@b.c via App | Show | "hi"'), true, 'an emoji prefix is still a head');
  assert.equal(startsBoostLine(TAIP), false, 'no pipes: a continuation');
  assert.equal(startsBoostLine('we raised 500 sats last night | not a boost'), false, 'a sentence that mentions sats is not a head');
  assert.equal(startsBoostLine('123 sats from someone via App'), false, 'no pipes: not this format');
  assert.equal(startsBoostLine(null), false);
});
