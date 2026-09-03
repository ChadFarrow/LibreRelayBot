// NIP-73 external content identifiers for a text relay.
//
// https://github.com/nostr-protocol/nips/blob/master/73.md
//   Podcast Feeds  "podcast:guid:<guid>"  k = "podcast:guid"
//
// This bot forwards IRC text. The only podcast identity in the message is a
// display name, so the feed GUID has to be looked up by title -- and a title is
// not an identifier. Two different feeds are both titled exactly "Stay Awhile"
// with different GUIDs, so anything less strict than "exactly one exact match"
// publishes a confidently wrong identifier, which is worse than publishing none:
// a wrong id mis-aggregates across every client that reads these tags, a missing
// one merely under-aggregates.
//
// There is never a podcast:item:guid here. The relayed text carries no episode
// identity at all, and inventing one from an episode title would be the same
// guess with worse odds.

import crypto from 'crypto';

const API = 'https://api.podcastindex.org/api/1.0/search/bytitle';

// Both outcomes are cached. A success is stable; so, in practice, is ambiguity --
// it is a property of the index, not a transient error, and re-querying "Stay
// Awhile" on every boost would spend a request to reach the same "no" each time.
// A null value means "asked, and the answer was not usable".
const feedGuidByName = new Map();

/**
 * Candidate show names from the pipe-delimited relay format:
 *   "BOOST | <field 1> | [MORE] | COMMENT"
 *
 * The formatter's comment calls field 1 the SHOW, but real traffic says it is the
 * EPISODE title -- "152nd Edition - VoidZero" and "99 - Lightning Thrashes" have
 * the same shape as the item_title in Fountain's own payloads ("147th Edition -
 * Haleen", whose feed is "Mutton, Mead & Music"). The show name is often only
 * present as a segment of that title, and sometimes not present at all.
 *
 * So return the whole field first, then its " - " segments, and let the caller
 * accept only an unambiguous answer. Segments must look like a title to be worth
 * asking about: a bare episode number would otherwise be searched on its own, and
 * "99" really does exact-match two feeds in the index.
 */
export function candidateShowNames(message) {
  if (typeof message !== 'string') return [];
  const parts = message.split(' | ').map(p => p.trim());
  if (parts.length < 3) return [];

  const field = parts[1].replace(/^["']|["']$/g, '').trim();
  if (!field || field.toLowerCase() === 'none') return [];

  const names = [field];
  for (const segment of field.split(/\s+[-\u2013\u2014]\s+/)) {
    const name = segment.trim();
    if (name === field) continue;
    // Must contain a letter, and be either multi-word or reasonably long. This is
    // what keeps "99" and "Exactly" from being looked up as podcast titles.
    const wordy = name.split(/\s+/).length >= 2 || name.length >= 8;
    if (/\p{L}/u.test(name) && wordy) names.push(name);
  }
  return names;
}

/** Kept for callers and tests that want the single most likely name. */
export function extractShowName(message) {
  return candidateShowNames(message)[0] ?? null;
}

export function buildPodcastTags(feedGuid) {
  if (!feedGuid) return [];
  return [
    ['i', `podcast:guid:${feedGuid}`],
    ['k', 'podcast:guid'],
  ];
}

/**
 * Resolve a show title to its feed GUID, but only when the answer is unambiguous.
 * Returns null for no match, several matches, or any failure -- callers then emit
 * no tag rather than a guess.
 */
export async function lookupUnambiguousFeedGuid(name, { logger = console } = {}) {
  if (!name) return null;

  const key = name.trim().toLowerCase();
  if (feedGuidByName.has(key)) return feedGuidByName.get(key);

  const apiKey = process.env.PODCAST_INDEX_API_KEY;
  const apiSecret = process.env.PODCAST_INDEX_API_SECRET;
  if (!apiKey || !apiSecret) return null; // not configured: silently skip the tags

  try {
    const apiTime = Math.floor(Date.now() / 1000);
    const hash = crypto.createHash('sha1')
      .update(apiKey + apiSecret + apiTime)
      .digest('hex');

    const response = await fetch(`${API}?q=${encodeURIComponent(name)}`, {
      headers: {
        'User-Agent': 'LibreRelayBot/1.0',
        'X-Auth-Date': String(apiTime),
        'X-Auth-Key': apiKey,
        'Authorization': hash,
      },
      // Sits in front of an IRC-triggered post; it must not hold one up.
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.warn?.(`Feed GUID lookup failed for "${name}": HTTP ${response.status}`);
      return null; // not cached: a transient failure should be retried
    }

    const data = await response.json();
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    const exact = feeds.filter(
      f => typeof f?.title === 'string' && f.title.trim().toLowerCase() === key && f.podcastGuid,
    );

    if (exact.length !== 1) {
      logger.info?.(
        `No unambiguous feed GUID for "${name}" (${exact.length} exact matches); publishing untagged`,
      );
      feedGuidByName.set(key, null);
      return null;
    }

    const guid = String(exact[0].podcastGuid).trim().toLowerCase();
    feedGuidByName.set(key, guid);
    logger.info?.(`Resolved feed GUID for "${name}": ${guid}`);
    return guid;
  } catch (error) {
    logger.warn?.(`Feed GUID lookup errored for "${name}": ${error?.message || error}`);
    return null;
  }
}

/** Never throws and never blocks a post: on any problem the message goes out untagged. */
export async function podcastTagsForMessage(message, opts = {}) {
  try {
    const found = new Set();
    for (const name of candidateShowNames(message)) {
      const guid = await lookupUnambiguousFeedGuid(name, opts);
      if (guid) found.add(guid);
      // The whole field matching outright is the strongest signal available;
      // stop rather than letting a segment contradict it.
      if (guid && name === candidateShowNames(message)[0]) break;
    }
    // Two segments naming two different feeds is not an answer, it is a coin flip.
    if (found.size !== 1) {
      if (found.size > 1) {
        opts.logger?.info?.(`Segments of "${message.split(' | ')[1]}" named ${found.size} feeds; publishing untagged`);
      }
      return [];
    }
    return buildPodcastTags([...found][0]);
  } catch {
    return [];
  }
}

export const __testing = { clearCache: () => feedGuidByName.clear() };
