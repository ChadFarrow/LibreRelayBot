# BoostAfterBoost - IRC to Nostr Bridge

## Repository Information
- **Purpose**: Monitor BoostAfterBoost bot messages in #BowlAfterBowl IRC channel and forward to Nostr
- **IRC Server**: irc.zeronode.net
- **Channel**: #BowlAfterBowl only
- **Target Bot**: BoostAfterBoost

## Bot Configuration
- **Read-only IRC**: Only monitors messages, never posts to IRC
- **Uses ZNC bouncer**: Connects through ZNC on localhost:6697 for reliability
- **Monitors specific bot**: Only processes messages from BoostAfterBoost bot
- **Posts to Nostr**: Forwards monitored messages to Nostr relays
- **Runs on port 3335**: Separate from other bots
- **Auto-recovery**: Automatically restarts ZNC if it stops

## Nostr Configuration
- **Environment Variable**: `NOSTR_NSEC`
- **Default Relays**: relay.damus.io, relay.nostr.band, nostr.mom, relay.primal.net, chadf.nostr1.com
- **Post Format**: Direct message forwarding with BowlAfterBowl hashtags

## Key Features
- IRC message monitoring for specific bot
- Read-only IRC connection (no posting to IRC)
- Selective message filtering (BoostAfterBoost bot only)
- Automatic Nostr forwarding
- Health monitoring and status endpoints

## Bot Management Commands

### Starting the Bot
```bash
cd /home/server/bots/BoostAfterBoost
pm2 start ecosystem.config.cjs
```

### ZNC Management
```bash
# Check if ZNC is running
nc -zv localhost 6697

# Start ZNC manually
/home/server/bots/BoostAfterBoost/start-znc.sh

# Start ZNC directly
znc --datadir=/home/server/.znc &

# Check ZNC status
ps aux | grep znc
```

### Environment Variables Needed
```bash
# Required
NOSTR_NSEC=your_nostr_private_key  # Your Nostr private key

# IRC Configuration (pre-configured)
IRC_SERVER=irc.zeronode.net
IRC_PORT=6667
IRC_CHANNEL=#BowlAfterBowl
IRC_NICKNAME=BoostAfterBoost_Reader
TARGET_BOT=BoostAfterBoost

# Optional
PORT=3334              # Default port
TEST_MODE=false        # Set to true for testing without posting
```

### Checking Bot Status
```bash
# Check if bot is running
ps aux | grep -v grep | grep boost-after-boost

# Health check
curl http://localhost:3334/health

# Status info
curl http://localhost:3334/status
```

### Stopping the Bot
```bash
# Find running processes
ps aux | grep -v grep | grep boost-after-boost

# Kill specific processes (replace PID with actual process ID)
kill [PID]
```

## Important Notes
- **Read-only IRC**: Bot never posts to IRC, only monitors
- **ZNC Dependency**: Requires ZNC bouncer running on localhost:6697
- **Single channel**: Only connects to #BowlAfterBowl
- **Specific bot monitoring**: Only processes BoostAfterBoost messages
- **Nostr forwarding**: All monitored messages forwarded to Nostr
- **Port 3335**: Runs on separate port to avoid conflicts
- **Auto-recovery**: Bot automatically restarts ZNC if it stops
- **SSL Configuration**: Accepts self-signed certificates for ZNC connection

## ZNC Configuration
- **Config Location**: `/home/server/.znc/configs/znc.conf`
- **User**: `ircbots`
- **Password**: `bassist89`
- **Network**: `zeronode` (connects to irc.zeronode.net)
- **Channel**: `#BowlAfterBowl`
- **Port**: 6697 (SSL)

## Development Workflow

### Safe Development Process
1. **Test Mode**: Set `TEST_MODE=true` to log without posting to Nostr
2. **Monitor Logs**: Watch console for IRC messages
3. **Test with Live Messages**: Verify forwarding works

### Test Mode Setup
```bash
# Set test environment variable
export TEST_MODE=true

# Start bot in test mode
TEST_MODE=true npm start
```

### Post Format
When BoostAfterBoost posts to IRC, the bot forwards to Nostr:
```
[Original message from BoostAfterBoost]

#BowlAfterBowl #BoostAfterBoost
```

## Technical Details
- **IRC Monitoring**: Connects to single channel and filters by bot name
- **Message Filtering**: Only processes messages from BoostAfterBoost
- **Nostr Publishing**: Direct message forwarding with hashtags
- **Duplicate Prevention**: Basic message handling to avoid spam
- **Health Endpoints**: /health and /status for monitoring
- **SSL/TLS**: Configured to accept self-signed certificates from ZNC bouncer

## Current Status (Updated 2025-07-15)
- **Bot Status**: ✅ Running and operational
- **IRC Connection**: ✅ Connected to ZNC bouncer via SSL
- **Channel Monitoring**: ✅ Monitoring #BowlAfterBowl for BoostAfterBoost messages
- **Nostr Configuration**: ✅ Configured with 4 default relays
- **Recent Fix**: SSL certificate validation issue resolved
- **Ready to Forward**: Bot will automatically forward BoostAfterBoost messages to Nostr