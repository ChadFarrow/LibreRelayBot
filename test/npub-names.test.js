import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNpubs,
  applyNames,
  cleanName,
  nameFromProfile,
  resolveNpubNames,
  __testing,
} from '../lib/npub-names.js';

// Frankie Peroni's key, as it arrived in the 2026-09-13 Homegrown Hits boost.
const NPUB = 'npub1cpd59nd6d5m42vta49lv8jnj8u5t4708h3a9uyt0uyggwmf4q78suul0rk';
const PUBKEY = 'c05b42cdba6d3755317da97ec3ca723f28baf9e7bc7a5e116fe110876d35078f';

const stub = (names) => async (pubkeys) =>
  new Map(pubkeys.filter((p) => names[p]).map((p) => [p, names[p]]));

beforeEach(() => __testing.clearCache());

test('finds a mention behind the nostr: scheme and bare', () => {
  assert.deepEqual(
    extractNpubs(`hi nostr:${NPUB} and ${NPUB}`).map((n) => n.token),
    [`nostr:${NPUB}`, NPUB],
  );
});

test('stops at 58 characters, so a key welded to the next mention survives', () => {
  // The sending app dropped the newline between two mentions, so the text reads
  // "…suul0rknostr:npub1…". A greedy charset match eats the leading "n" of
  // "nostr" and breaks the key it just read.
  const found = extractNpubs(`nostr:${NPUB}nostr:${NPUB}Waving the flag`);
  assert.equal(found.length, 1, 'the two tokens are identical, so one entry');
  assert.equal(found[0].npub, NPUB);
  assert.equal(found[0].pubkey, PUBKEY);
});

test('a truncated key is not a key', () => {
  // Exactly what published before the IRC lines were rejoined.
  assert.deepEqual(extractNpubs('nostr:npub1cpd59nd6d5m42vta49lv8jnj8u5t4708h3a9uyt0uyg'), []);
});

test('a key that fails its checksum is left alone', () => {
  const wrong = NPUB.slice(0, -1) + (NPUB.endsWith('k') ? 'j' : 'k');
  assert.deepEqual(extractNpubs(wrong), []);
});

test('the name replaces the whole token, scheme included', async () => {
  const out = await resolveNpubNames(`saying "thanks nostr:${NPUB}"`, {
    lookup: stub({ [PUBKEY]: 'Frankie Peroni' }),
  });
  assert.equal(out, 'saying "thanks @Frankie Peroni"');
});

test('a name does not weld to the text the app ran it into', async () => {
  const out = await resolveNpubNames(`music. nostr:${NPUB}nostr:${NPUB}Waving the flag`, {
    lookup: stub({ [PUBKEY]: 'Frankie Peroni' }),
  });
  assert.equal(out, 'music. @Frankie Peroni @Frankie Peroni Waving the flag');
});

test('an unresolvable key stays an npub', async () => {
  const text = `thanks nostr:${NPUB}`;
  assert.equal(await resolveNpubNames(text, { lookup: stub({}) }), text);
});

test('a lookup that throws changes nothing', async () => {
  const text = `thanks nostr:${NPUB}`;
  const out = await resolveNpubNames(text, {
    lookup: async () => { throw new Error('relays down'); },
    logger: { warn() {} },
  });
  assert.equal(out, text);
});

test('text with no mention never reaches the relays', async () => {
  let called = false;
  const out = await resolveNpubNames('boosted 666 sats saying "nice one"', {
    lookup: async () => { called = true; return new Map(); },
  });
  assert.equal(out, 'boosted 666 sats saying "nice one"');
  assert.equal(called, false);
});

test('a resolved name is cached, so a boost storm asks once', async () => {
  let calls = 0;
  const lookup = async (pubkeys) => { calls++; return new Map(pubkeys.map((p) => [p, 'Frankie Peroni'])); };

  await resolveNpubNames(`a nostr:${NPUB}`, { lookup });
  const second = await resolveNpubNames(`b nostr:${NPUB}`, { lookup });

  assert.equal(calls, 1);
  assert.equal(second, 'b @Frankie Peroni');
});

test('display_name wins over name, and both are bounded to one line', () => {
  assert.equal(nameFromProfile({ content: '{"name":"frankie","display_name":"Frankie Peroni"}' }), 'Frankie Peroni');
  assert.equal(nameFromProfile({ content: '{"name":"frankie"}' }), 'frankie');
  assert.equal(nameFromProfile({ content: 'not json' }), null);
  assert.equal(nameFromProfile({ content: '{"display_name":"  "}' }), null);
});

test('a hostile profile name cannot forge structure in the note', () => {
  assert.equal(cleanName('Frankie\nPeroni'), 'Frankie Peroni');
  assert.equal(cleanName('@@Frankie'), 'Frankie');
  assert.equal(cleanName('x'.repeat(200)).length, 64);
});

test('applyNames leaves a name-less key untouched', () => {
  const text = `thanks nostr:${NPUB}`;
  assert.equal(applyNames(text, new Map()), text);
});
