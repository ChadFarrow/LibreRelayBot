// Turn the npubs a boostagram carries into the names people recognise.
//
// A payer writes their boost message in an app that stores mentions as keys, so
// what reaches IRC is `nostr:npub1cpd59…suul0rk` where the payer typed
// "@Frankie Peroni". Some Nostr clients resolve that back to a name at render
// time and some do not, and the one thing none of them can resolve is an npub
// with no `nostr:` in front of it. So the name is looked up here, once, and the
// note says it in plain text.
//
// THE MATCH IS A FIXED LENGTH, ON PURPOSE. An npub is `npub1` plus exactly 58
// bech32 characters, and boostagram text runs mentions together with whatever
// follows -- `…suul0rknostr:npub1…`, no separator, because the sending app dropped
// the newline between two mentions. A greedy `[charset]+` match would swallow the
// `n` of the next `nostr:` and break the key it just read. Counting to 58 stops
// exactly where the key stops.
//
// Every failure leaves the text alone. A relay that is slow, a profile with no
// name, a key that does not decode: the npub stays as it was and the note still
// publishes. This runs in front of a post and must never hold one up.

import { nip19, SimplePool } from 'nostr-tools';

/** `npub1` + 58 bech32 characters, optionally introduced by the NIP-21 scheme. */
export const NPUB_PATTERN = /(nostr:)?(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})/g;

const DEFAULT_TIMEOUT_MS = 4000;
const HIT_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE = 500;
const MAX_NAME_LENGTH = 64;

// pubkey -> { name, until }. A miss is cached briefly rather than forever: a new
// profile can be published after the first boost that mentions it.
const nameByPubkey = new Map();

let pool = null;
function sharedPool() {
  // One pool for the process. Each call would otherwise open and drop a socket per
  // relay, and these relays are the same ones the note is about to be published to.
  if (!pool) pool = new SimplePool();
  return pool;
}

/** Every valid npub in the text, with the exact token to replace. */
export function extractNpubs(text) {
  if (typeof text !== 'string') return [];
  const found = [];
  const seen = new Set();

  for (const match of text.matchAll(NPUB_PATTERN)) {
    const [token, , npub] = match;
    if (seen.has(token)) continue;
    let pubkey;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') continue;
      pubkey = decoded.data;
    } catch {
      // Bech32 has a checksum, so this is a typo or a truncation, not a key.
      continue;
    }
    seen.add(token);
    found.push({ token, npub, pubkey });
  }

  return found;
}

/** A profile name fit to drop into a note: one line, bounded, no leading sigil. */
export function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^@+/, '')
    .trim();
  if (!name) return null;
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH).trim() : name;
}

/** The display name a kind:0 event declares, if it declares one. */
export function nameFromProfile(event) {
  try {
    const meta = JSON.parse(event?.content ?? '');
    return cleanName(meta?.display_name) || cleanName(meta?.name) || null;
  } catch {
    return null;
  }
}

/** Replace each npub token with @name. Tokens with no name are left untouched. */
export function applyNames(text, namesByPubkey) {
  const WORD = /[\p{L}\p{N}]/u;
  let out = '';
  let last = 0;

  for (const match of text.matchAll(NPUB_PATTERN)) {
    const [token, , npub] = match;
    let pubkey;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') continue;
      pubkey = decoded.data;
    } catch {
      continue;
    }

    const name = namesByPubkey.get(pubkey);
    if (!name) continue;

    out += text.slice(last, match.index);
    // The sending app ran these mentions together with the words around them: it
    // dropped the newlines they sat on, which is how one npub ends up welded to
    // the next and to the sentence after it. A name must not inherit that --
    // "@Right Said FredWaving the flag" is not a name anyone can read.
    if (out && WORD.test(out.slice(-1))) out += ' ';
    out += `@${name}`;

    last = match.index + token.length;
    if (text[last] && WORD.test(text[last])) out += ' ';
  }

  return out + text.slice(last);
}

function cached(pubkey) {
  const entry = nameByPubkey.get(pubkey);
  if (!entry) return undefined;
  if (entry.until < Date.now()) { nameByPubkey.delete(pubkey); return undefined; }
  return entry.name;
}

function remember(pubkey, name) {
  // Cleared rather than evicted when full, as the other caches in this stack are:
  // it is an optimization, and rebuilding it costs one lookup per name.
  if (nameByPubkey.size >= MAX_CACHE) nameByPubkey.clear();
  nameByPubkey.set(pubkey, { name, until: Date.now() + (name ? HIT_TTL_MS : MISS_TTL_MS) });
}

/** kind:0 for several keys in one round trip. Returns a Map; never throws. */
async function lookupFromRelays(pubkeys, { relays, timeoutMs, logger }) {
  const names = new Map();
  if (!Array.isArray(relays) || relays.length === 0) return names;

  try {
    // querySync resolves only when the subscription closes. maxWait is the relay
    // library's EOSE timeout, not a guarantee one arrives -- and this sits in front
    // of a publish, so a relay that neither EOSEs nor closes must not be able to
    // hold a boost. The race is the floor under that.
    const events = await Promise.race([
      sharedPool().querySync(relays, { kinds: [0], authors: pubkeys }, { maxWait: timeoutMs }),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve([]), timeoutMs + 1000);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);

    // Several relays answer for the same key; keep the newest profile.
    const newest = new Map();
    for (const event of events) {
      const prev = newest.get(event.pubkey);
      if (!prev || event.created_at > prev.created_at) newest.set(event.pubkey, event);
    }
    for (const [pubkey, event] of newest) {
      const name = nameFromProfile(event);
      if (name) names.set(pubkey, name);
    }
  } catch (error) {
    logger?.warn?.(`npub name lookup failed: ${error?.message || error}`);
  }

  return names;
}

/**
 * The text with every resolvable npub replaced by its owner's name. Returns the
 * text unchanged on any problem, and never throws.
 */
export async function resolveNpubNames(text, options = {}) {
  const {
    relays = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger,
    lookup = lookupFromRelays,
  } = options;

  try {
    const npubs = extractNpubs(text);
    if (npubs.length === 0) return text;

    const names = new Map();
    const unknown = [];
    for (const { pubkey } of npubs) {
      const hit = cached(pubkey);
      if (hit === undefined) unknown.push(pubkey);
      else if (hit) names.set(pubkey, hit);
    }

    if (unknown.length > 0) {
      const fetched = await lookup(unknown, { relays, timeoutMs, logger });
      for (const pubkey of unknown) {
        const name = fetched.get(pubkey) || null;
        remember(pubkey, name);
        if (name) names.set(pubkey, name);
      }
    }

    if (names.size === 0) return text;
    logger?.info?.(`🪪 Resolved ${names.size}/${npubs.length} npub(s) to names`);
    return applyNames(text, names);
  } catch (error) {
    logger?.warn?.(`npub name resolution skipped: ${error?.message || error}`);
    return text;
  }
}

export const __testing = {
  cache: nameByPubkey,
  clearCache: () => nameByPubkey.clear(),
};
