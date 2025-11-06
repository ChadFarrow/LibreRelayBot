# LibreRelayBot - IRC to Nostr Bridge

LibreRelayBot monitors messages from the LibreRelayBot in the #SirLibre IRC channel and forwards them to Nostr.

## Features

- 🔍 **Selective Monitoring** - Only monitors messages from the LibreRelayBot bot
- 📖 **Read-Only IRC** - Never posts to IRC, only monitors
- 📱 **Nostr Integration** - Forwards all monitored messages to Nostr
- 🛡️ **Single Channel Focus** - Dedicated to #SirLibre channel only
- ⚡ **Real-time Forwarding** - Messages appear on Nostr immediately
- 🔧 **Easy Setup** - Simple configuration with environment variables

## Quick Start

1. **Clone and Install**
   ```bash
   git clone [your-repo-url]
   cd LibreRelayBot
   npm install
   ```

2. **Generate Nostr Key**
   ```bash
   # Install noscl if needed
   go install github.com/fiatjaf/noscl@latest
   
   # Generate key pair
   noscl key-gen
   ```

3. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your NOSTR_NSEC
   ```

4. **Run LibreRelayBot**
   ```bash
   npm start
   ```

## Configuration

Create a `.env` file with:

```bash
# Required: Your Nostr private key
NOSTR_NSEC=your_nostr_private_key_here

# IRC Configuration (pre-configured)
IRC_SERVER=irc.zeronode.net
IRC_PORT=6667
IRC_CHANNEL=#SirLibre
IRC_NICKNAME=LibreRelayBot_Reader
TARGET_BOT=LibreRelayBot

# Optional: Port (default: 3336)
PORT=3336

# Optional: Test mode
TEST_MODE=false
```

## How It Works

1. **IRC Connection** - Connects to irc.zeronode.net and joins #SirLibre
2. **Message Monitoring** - Listens to all messages in the channel
3. **Bot Filtering** - Only processes messages from the LibreRelayBot bot
4. **Nostr Forwarding** - Forwards filtered messages to configured Nostr relays
5. **Read-Only Operation** - Never sends messages to IRC, only monitors

## Post Format

When LibreRelayBot posts to IRC, the bot forwards to Nostr:

```
[Original message from LibreRelayBot]

#SirLibre #LibreRelayBot
```

## Commands

```bash
npm start          # Start LibreRelayBot bridge
npm run dev        # Start with file watching
npm run health     # Check if running
npm run status     # Get status info
npm run pm2:start  # Start with PM2 process manager
npm run pm2:logs   # View PM2 logs
```

## Technical Details

- **Built with**: Node.js, Express, nostr-tools, irc
- **IRC Server**: irc.zeronode.net (hardcoded)
- **Channel**: #SirLibre only
- **Target Bot**: LibreRelayBot
- **Relays**: relay.damus.io, relay.nostr.band, nostr.mom, relay.primal.net, chadf.nostr1.com
- **Port**: 3336 (configurable)
- **Operation**: Read-only IRC connection

## Development

1. **Test Mode**: Set `TEST_MODE=true` to log without posting to Nostr
2. **Local Testing**: Bot runs on `http://localhost:3336`
3. **Health Check**: `curl http://localhost:3336/health`
4. **Status**: `curl http://localhost:3336/status`
5. **Logs**: Check `logs/` directory or use `npm run pm2:logs`

## Production Deployment

### Using PM2
```bash
# Start with PM2
npm run pm2:start

# View logs
npm run pm2:logs

# Restart
npm run pm2:restart

# Stop
npm run pm2:stop
```

### Manual Process Management
```bash
# Check if running
ps aux | grep -v grep | grep libre-relay-bot

# Kill process (replace PID)
kill [PID]
```

## Important Notes

- 📖 **Read-Only**: This bot NEVER posts to IRC
- 🎯 **Single Purpose**: Only monitors LibreRelayBot bot messages
- 📍 **Single Channel**: Only connects to #SirLibre
- 🔒 **Security**: `.env` file is gitignored to protect your nsec
- ⚠️ **Port Conflict**: Runs on port 3336 to avoid conflicts with other bots

## About SirLibre

SirLibre is an IRC channel on irc.zeronode.net where the LibreRelayBot operates. This bridge ensures that all LibreRelayBot messages are also available on Nostr for wider distribution and archival.

## License

MIT
