// Rejoin the IRC lines of one message before anything downstream sees them.
//
// IRC carries no concept of a long message: a sender with more to say than fits in
// a line emits several, and the announcer bots this relay reads do exactly that. Each
// line arrived here as its own Nostr note, so one boost became three permanent,
// unconnected notes -- and only the last of them carried the trailing `via <App>`
// the tags are read from.
//
// THE CUT IS A CHARACTER COUNT, NOT A WORD BOUNDARY. A real boost split mid-npub:
//
//   line 1  …saying "Thank you… nostr:npub1cpd59nd6d5m42vta49lv8jnj8u5t4708h3a9uyt0uyg
//   line 2  gwmf4q78suul0rk@Right Said Fred…
//
// Those halves are one 63-character npub, and it decodes only because the join adds
// nothing: bech32 carries a checksum, so a byte at the seam would fail it. Captured
// lines show the same shape elsewhere ("mething tells me…" is the tail of
// "so|mething"). So fragments are joined with NO separator -- inserting a space
// corrupts every cut that lands inside a word.
//
// For the same reason they must be joined RAW, before sanitizing. Sanitizing trims,
// and a cut that DOES land on a space leaves that space at the end of a fragment
// ("…for this musical " + "ecosystem yet?"); trim first and the two words weld
// together.
//
// Nothing here knows what a boost looks like. The caller supplies isStart(line) --
// "this line begins a new message" -- because each bot reads a different announcer
// format. A line that is not a start and has nothing to continue is emitted on its
// own, which is what this relay did with every line before, so an isStart that fails
// to recognise something degrades to the old behaviour rather than gluing unrelated
// messages together.

import { logger as defaultLogger } from './logger.js';

/** Idle time after the last fragment before a message is considered complete. */
export const DEFAULT_WINDOW_MS = 2500;

/** Runaway guards. A real boost is 1-3 fragments; these are not limits, they are brakes. */
export const MAX_FRAGMENTS = 12;
export const MAX_LENGTH = 8000;

export class MessageAssembler {
  constructor({
    isStart,
    onMessage,
    windowMs = DEFAULT_WINDOW_MS,
    maxFragments = MAX_FRAGMENTS,
    maxLength = MAX_LENGTH,
    logger = defaultLogger,
    // Injectable so tests do not have to wait out a real window.
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (typeof isStart !== 'function') {
      throw new TypeError('MessageAssembler requires an isStart(line) predicate');
    }
    if (typeof onMessage !== 'function') {
      throw new TypeError('MessageAssembler requires an onMessage(text, meta) callback');
    }

    this.isStart = isStart;
    this.onMessage = onMessage;
    this.windowMs = Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_WINDOW_MS;
    this.maxFragments = maxFragments;
    this.maxLength = maxLength;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.pending = null;
    this.timer = null;
    this.stats = { messagesAssembled: 0, fragmentsCombined: 0 };
  }

  /** Feed one raw IRC line. */
  push(line) {
    if (typeof line !== 'string' || line === '') return;

    if (this._startsMessage(line)) {
      // Whatever was pending is finished: the sender has moved on.
      this.flush('next message');
      this.pending = { parts: [line], length: line.length };
      this._arm();
      return;
    }

    if (!this.pending) {
      // Not a start and nothing to continue -- ordinary chatter from the bot we
      // watch. Relay it alone, exactly as this bot always has.
      this._emit(line, 1, 'standalone');
      return;
    }

    this.pending.parts.push(line);
    this.pending.length += line.length;

    if (this.pending.parts.length >= this.maxFragments || this.pending.length >= this.maxLength) {
      this.logger?.warn?.(
        `Assembled message hit its limit (${this.pending.parts.length} fragments, ` +
        `${this.pending.length} chars); emitting early`,
      );
      this.flush('limit');
      return;
    }

    this._arm();
  }

  /** Emit whatever is pending, if anything. Safe to call at any time. */
  flush(reason = 'timeout') {
    this._disarm();
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    this._emit(pending.parts.join(''), pending.parts.length, reason);
  }

  /** Drop the timer without emitting. For shutdown, after a final flush(). */
  stop() {
    this._disarm();
  }

  getStats() {
    return { ...this.stats, pendingFragments: this.pending ? this.pending.parts.length : 0 };
  }

  _startsMessage(line) {
    try {
      return Boolean(this.isStart(line));
    } catch (error) {
      // A predicate that throws must not swallow the line into someone else's
      // message. Treating it as a start gives one note per line -- the old
      // behaviour -- rather than a corrupted join.
      this.logger?.warn?.(`isStart() threw, treating the line as its own message: ${error?.message || error}`);
      return true;
    }
  }

  _arm() {
    this._disarm();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush('timeout');
    }, this.windowMs);
  }

  _disarm() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  _emit(text, fragments, reason) {
    this.stats.messagesAssembled++;
    if (fragments > 1) {
      this.stats.fragmentsCombined += fragments;
      this.logger?.info?.(`🧩 Combined ${fragments} IRC lines into one message (${reason})`);
    }

    try {
      const result = this.onMessage(text, { fragments, reason });
      // onMessage posts to Nostr, so it is async. An unhandled rejection here would
      // reach the process-level handler and say nothing about which message failed.
      if (result && typeof result.catch === 'function') {
        result.catch((error) => this.logger?.error?.('Assembled message handler failed:', error));
      }
    } catch (error) {
      this.logger?.error?.('Assembled message handler threw:', error);
    }
  }
}
