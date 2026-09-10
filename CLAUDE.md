# LibreRelayBot - IRC to Nostr Bridge

## Repository Information
- **Purpose**: Monitor the `LibreRelayBot` bot's messages in the `#SirLibre` IRC channel and forward V4V (value-for-value) boost notifications to Nostr
- **IRC Server**: irc.zeronode.net, reached via the shared ZNC container in the `/opt/bots` stack
- **Channel**: `#SirLibre`
- **Target Bot**: `LibreRelayBot` (only messages from this nick are relayed)
- **Port**: 3336 (HTTP health/status server)
- **Read-only IRC**: monitors only, never posts to IRC

## Architecture

Single entry point `libre-relay-bot.js` (run via `npm start` → `node libre-relay-bot.js`). Core classes:
- `Config` — loads settings from environment/`.env`
- `Security` — input sanitization + rate limiting
- `NostrClient` — signs and publishes Nostr events (nostr-tools)
- `LibreRelayBotBridge` — orchestrates IRC ↔ Nostr

Supporting files:
- `lib/irc-client.js` — `IRCClient` wrapper around the `irc` package (connect, keepalive, auto-rejoin, reconnect). Reaches ZNC over the compose bridge network in the clear, so no certificate handling is needed, and passes the IRC `password` in ZNC's `user@clientid/network:password` form.
- `lib/logger.js` — timestamped logging

Dependencies: `nostr-tools ^2.7.0`, `irc ^0.5.2`, `express`, `dotenv`.

> Note: `boost-after-boost.js` in this repo is a legacy sibling script and is **not** what runs in production — `libre-relay-bot.js` is the live entry point.

## Data Flow
1. Connect to the `znc` container at `znc:6667` (plaintext, bridge network only) → ZNC relays to irc.zeronode.net, joins `#SirLibre`.
2. `_handleIRCMessage` filters to messages `from === TARGET_BOT` ("LibreRelayBot"), applies a rate limit (5 msgs / 60s per sender).
3. `Security.sanitizeMessage` strips control characters (no length cap).
4. `_formatV4VMessage` parses the pipe-delimited boost line into a formatted note.
5. `NostrClient.publishMessage` signs a `kind:1` event and publishes to all relays.

## Message Formatting (`_formatV4VMessage`)

The IRC boost line is pipe-delimited (` | `). The **number of middle metadata fields varies by source** (v4vmusic sends fewer, Fountain sends more), so parsing is positional from the ends:
- **First** segment → `⚡` boost line (sender + app kept verbatim, e.g. `mattfinlay@fountain.fm via Fountain`)
- **Last** segment → `💬` boost comment
- **Middle** segments → metadata lines, one each, cycling emojis `🎵` / `🎧` / `🎶`

Filtering: middle fields equal to `None` are skipped; a comment that is empty, `None`, `no message`, starts with `auto boost`, or is a trailing `sent from v4vmusic.com…` note produces no `💬` line. Every note ends with a `#V4V` line and `https://v4vmusic.com`.

Example output:
```
⚡ 123 sats from mattfinlay@fountain.fm via Fountain

🎵 Summer Shorts Edition 2

🎧 Every time a new surprise

🎶 Don't be a fool

💬 "Give Spotify my hard-earned … Two For Tunestr? 🤔"

#V4V
https://v4vmusic.com
```

If the line has fewer than 2 segments (or parsing throws), the raw message is posted with the `#V4V` footer.

> History: an earlier version hard-coded a 4-field layout and read the comment from `parts[3]`, which **dropped the real comment** on 5-field Fountain boosts. It also capped the raw line at 280 chars before parsing. Both were fixed — the comment is now always the last segment and there is no length cap.

## Nostr Configuration
- **Key**: `NOSTR_NSEC` (nsec, decoded via `nip19`)
- **Event**: `kind: 1` text note, tags `[['t','v4v']]`
- **Library**: nostr-tools (`finalizeEvent`, `Relay` from `nostr-tools/relay`)
- **Default relays** (used when `NOSTR_RELAYS` is unset): `relay.damus.io`, `relay.nostr.band`, `nostr.mom`, `relay.primal.net`, `chadf.nostr1.com`
- **TEST_MODE**: `true` logs the formatted note instead of publishing

## Configuration (compose + `/opt/bots/env/lrb.env`)
```bash
NOSTR_NSEC=...            # required
# NOSTR_RELAYS=...        # optional, comma-separated; defaults used if unset
TARGET_BOT=LibreRelayBot
IRC_CHANNEL="#SirLibre"
IRC_SERVER=znc            # the ZNC container on the compose bridge network
IRC_PORT=6667
IRC_SECURE=false
IRC_NICKNAME=LibreRelayReader
IRC_USERNAME=ircbots
IRC_PASSWORD=ircbots@lrb/zeronode:<znc password>   # clientid form -- see below
PORT=3336
TEST_MODE=false
```
The non-secret IRC values are set in `bots/docker-compose.yml` (in the
`thelounge-candr` repo); `NOSTR_NSEC`, `NOSTR_RELAYS` and `IRC_PASSWORD` live in
`/opt/bots/env/lrb.env` on the VPS, mode 600, and nowhere in git.

## Deployment (Docker on the candr VPS)

A container in the `/opt/bots` stack on `104.237.150.197`, alongside `znc`,
`lit-bot` and `boost-after-boost`. Deployed from the `thelounge-candr` repo:

```bash
./deploy-bots.sh 104.237.150.197
```

```bash
ssh root@104.237.150.197 'cd /opt/bots && docker compose restart libre-relay-bot'
ssh root@104.237.150.197 'cd /opt/bots && docker compose ps libre-relay-bot'
ssh root@104.237.150.197 'docker logs -f libre-relay-bot'
```

`mem_limit` is 128M, set in the compose file. Logs go to Docker's json-file driver
with rotation (10MB x 3), which is why the old `librerelaybot.logrotate` is gone.

### Why a shared ZNC

ZeroNode enforces a per-IP connection limit and the old Ubuntu host hit it, dropping
connections. ZNC opens **one** upstream connection per (user, network) and lets
several clients attach at once, sharing the connection and the nick. This bot is
read-only, so sharing LIT_Bot's nick is invisible to the network. Three ZeroNode
connections became one.

The `@lrb` clientid in `IRC_PASSWORD` is what makes this bot a distinct ZNC client
rather than three sessions fighting over one.

**ZNC buffers are zero on purpose.** This bot dedupes in memory only — it keeps no
state across restarts — so a buffer replay on reattach would republish old boosts to
Nostr as brand-new notes.

## Health Checks
```bash
curl http://localhost:3336/health   # {"status":"healthy","connected":true,...}
curl http://localhost:3336/status   # detailed status
```

## Supervision Notes
- Docker's `restart: unless-stopped` plus the IRC client's keepalive/auto-reconnect
  handle process and connection recovery.
- `monitor-health.sh` and `librerelaybot.logrotate` were deleted in the VPS
  migration. Both hardcoded `/home/server/LibreRelayBot` and a `server` user that
  does not exist on the VPS; the watchdog also checked the wrong port (3337) and
  `pkill`ed a supervised process. Docker's json-file rotation replaces the logrotate
  config. Do not resurrect either.
- After a ZeroNode server reset, verify the bot re-joined `#SirLibre` (a bot can be
  "up" but silently disconnected) via `/status`. Note the rejoin now happens at the
  ZNC layer, so check `docker logs znc` too.

## Migration to the candr VPS (September 2026)

Moved off the local Ubuntu server (`/home/server/LibreRelayBot`, systemd + ZNC on the
host) to the candr VPS as a container in the `/opt/bots` stack.

**Why:** the home IP had hit ZeroNode's per-IP connection limit and connections were
being dropped. Moving sheds this bot's connection from that IP, and the shared ZNC on
the VPS means all three bots together cost the new IP one connection, not three.

**What changed in this repo:**
- `Dockerfile` + `.dockerignore`. Two stages so `build-essential`/`python3` — needed
  for `irc`'s optional native deps — don't ship in the runtime image. Runs as the
  `node` user (uid 1000). `CMD` is `libre-relay-bot.js`, explicitly **not** the
  legacy `boost-after-boost.js` sibling, which would monitor the wrong bot in the
  wrong channel.
- `lib/irc-client.js`: deleted the ZNC health-check and auto-restart block. It
  `execAsync`'d `/home/server/bots/BoostAfterBoost/start-znc.sh` — note that was
  *BoostAfterBoost's* path, in this repo's code — and probed a hardcoded
  `localhost:6697`. The call site was already commented out, so this was dead code
  carrying a stale and wrong host assumption. The container restart policy owns ZNC.
- `lib/irc-client.js`: dropped `encoding: 'utf8'`, the fix BoostAfterBoost already
  took. It makes the `irc` library `require('node-icu-charset-detector')` on every
  message; removing it means one fewer native module in the image. ZeroNode is UTF-8
  and this bot is read-only, so default decoding is correct.
- `start-znc.sh`: deleted. All three bot repos shipped a byte-identical copy writing
  the same `/tmp/znc-boostbot.pid` and the same log path.
- `monitor-health.sh`, `librerelaybot.logrotate`: deleted (see Supervision Notes).
- pm2 `PORT` 3337 → **3336**, matching the code default and the docs. The code
  default was already right; only pm2 and the dead watchdog disagreed.
- `.env.example` was a verbatim copy of BoostAfterBoost's and named
  `#BowlAfterBowl` / `TARGET_BOT=BoostAfterBoost` — wrong for this bot. Rewritten.
- The ZNC password was committed in cleartext in this file. It has been removed and
  should be rotated — note that removing it here does not remove it from git history.

**Rollback:** `ecosystem.config.cjs` and `setup-service.sh` are deliberately left in
place, so the old host can take this bot back once `IRC_SERVER`/`IRC_PORT` point at a
local ZNC again.

