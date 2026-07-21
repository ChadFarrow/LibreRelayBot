# LibreRelayBot - IRC to Nostr Bridge

## Repository Information
- **Purpose**: Monitor the `LibreRelayBot` bot's messages in the `#SirLibre` IRC channel and forward V4V (value-for-value) boost notifications to Nostr
- **IRC Server**: irc.zeronode.net, reached via a local ZNC bouncer
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
- `lib/irc-client.js` — `IRCClient` wrapper around the `irc` package (connect, keepalive, auto-rejoin, reconnect). Configured for the ZNC bouncer: `secure: true` with `selfSigned: true`/`certExpired: true` (ZNC uses a self-signed cert) and passes the IRC `password` (`username:password` form for ZNC).
- `lib/logger.js` — timestamped logging

Dependencies: `nostr-tools ^2.7.0`, `irc ^0.5.2`, `express`, `dotenv`.

> Note: `boost-after-boost.js` in this repo is a legacy sibling script and is **not** what runs in production — `libre-relay-bot.js` is the live entry point.

## Data Flow
1. Connect to ZNC bouncer at `localhost:6697` (SSL) → ZNC relays to irc.zeronode.net, joins `#SirLibre`.
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

## Configuration (`.env` / systemd)
```bash
NOSTR_NSEC=...            # required
# NOSTR_RELAYS=...        # optional, comma-separated; defaults used if unset
TARGET_BOT=LibreRelayBot
IRC_CHANNEL="#SirLibre"
IRC_SERVER=localhost      # ZNC bouncer
IRC_PORT=6697
IRC_SECURE=true
IRC_NICKNAME=LibreRelayReader
IRC_USERNAME=librerelay
IRC_PASSWORD=librerelay:bassist89   # ZNC username:password
PORT=3336
TEST_MODE=false
```
Most IRC values are set via `Environment=` directives in the systemd service; `NOSTR_NSEC`/`NOSTR_RELAYS` live in `.env` (`EnvironmentFile=`).

## Deployment (systemd)

Service: `/etc/systemd/system/librerelaybot.service` (`Type=simple`, `Restart=always`, `RestartSec=15`, `MemoryMax=256M`, `CPUQuota=30%`). Depends on `znc.service`.

```bash
sudo systemctl restart librerelaybot
sudo systemctl status librerelaybot
```

Logs: stdout/stderr append to `systemd.log` / `systemd-error.log` in the project dir.

## Health Checks
```bash
curl http://localhost:3336/health   # {"status":"healthy","connected":true,...}
curl http://localhost:3336/status   # detailed status
```

## Supervision Notes
- systemd `Restart=always` plus the IRC client's built-in keepalive/auto-reconnect handle process and connection recovery.
- `monitor-health.sh` is a legacy external watchdog and is **no longer scheduled** (it checked the wrong port — 3337 instead of 3336 — and needlessly `pkill`ed the systemd process every 5 minutes). Do not re-add it to cron without fixing the port and switching it to `systemctl restart`.
- After a ZeroNode server reset, verify the bot re-joined `#SirLibre` (a bot can be "up" but silently disconnected) via `/status`.
