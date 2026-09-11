import irc from 'irc';
import { logger } from './logger.js';

export class IRCClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 10000; // 10 seconds
    this.keepAliveInterval = null;
    this.reconnecting = false;
  }

  async connect() {
    // Clean up existing connection and intervals
    this.disconnect();

    // Server comes from config: in production that is the ZNC container on the
    // compose bridge network (IRC_SERVER=znc), which multiplexes one ZeroNode
    // connection across all three bots. ZNC's own lifecycle belongs to the
    // container runtime's restart policy, not to this process.
    const server = this.config.server || 'irc.zeronode.net';
    const port = this.config.port || 6667;
    const secure = this.config.secure || false;

    logger.info('Connecting to IRC server...', {
      server: server,
      port: port,
      secure: secure,
      channels: this.config.channels,
      nickname: this.config.nickname
    });

    this.client = new irc.Client(server, this.config.nickname, {
      port: port,
      secure: secure,
      selfSigned: true,
      certExpired: true,
      autoRejoin: true,
      autoConnect: true,
      channels: this.config.channels,
      realName: this.config.realName || 'LibreRelayBot Reader Bot',
      userName: this.config.userName || 'boost_reader',
      password: this.config.password,
      retryCount: 0, // Disable built-in retry to avoid conflicts
      retryDelay: 5000,
      floodProtection: true,
      floodProtectionDelay: 1000,
      messageSplit: 512,
      stripColors: true,
      // No `encoding` option: it makes the `irc` lib require the native
      // `node-icu-charset-detector` module on every message. ZeroNode is UTF-8 and
      // this bot is read-only, so default decoding is correct and there is one
      // fewer native module to compile in the image.
      showErrors: true,
      debug: false
    });

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.on('registered', () => {
      logger.info('Successfully registered with IRC server');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.startKeepAlive();
    });

    this.client.on('join', (channel, nick) => {
      if (nick === this.config.nickname) {
        logger.info(`Joined IRC channel: ${channel}`);
      }
    });

    this.client.on('error', (error) => {
      logger.error('IRC connection error:', error);
      this.isConnected = false;
    });

    this.client.on('close', () => {
      logger.warn('IRC connection closed');
      this.isConnected = false;
      this.stopKeepAlive();
      // Only attempt reconnect on close (not disconnect)
      this.attemptReconnect();
    });

    this.client.on('disconnect', () => {
      logger.warn('IRC disconnected');
      this.isConnected = false;
      this.stopKeepAlive();
      // Don't reconnect on disconnect - let close event handle it
    });

    this.client.on('message', (from, to, message) => {
      logger.debug(`IRC message from ${from} to ${to}: ${message}`);
    });

    // Add ping handler to keep connection alive
    this.client.on('ping', (server) => {
      logger.debug('Received ping from server, sending pong');
      this.client.send('PONG', server);
    });

    // Add pong handler
    this.client.on('pong', (server) => {
      logger.debug('Received pong from server');
    });
  }

  attemptReconnect() {
    // Prevent multiple reconnection attempts
    if (this.reconnecting) {
      logger.debug('Reconnection already in progress, skipping');
      return;
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnecting = true;
      this.reconnectAttempts++;
      logger.info(`Attempting IRC reconnection (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      
      setTimeout(() => {
        this.reconnecting = false;
        if (!this.isConnected) { // Only reconnect if still not connected
          this.connect();
        }
      }, this.reconnectDelay);
    } else {
      logger.error('Max IRC reconnection attempts reached');
      // Stop the keepalive interval to prevent spam
      this.stopKeepAlive();
      // Exit, so whatever supervises us can restart us.
      //
      // Returning here instead leaves the Express server happily serving while
      // the bot is permanently disconnected: the container reads `Up`, Docker's
      // restart policy never fires (it reacts to exit, not to health), and
      // nothing is relayed until a human notices. Under docker compose this
      // hands control to `restart: unless-stopped`; under pm2 it is the same
      // deal. /health already reports 503 in this state, but nothing consumes
      // that on its own.
      process.exit(1);
    }
  }

  async postMessage(message, channels = null) {
    // Check if connection is active
    if (!this.isConnectionActive()) {
      logger.warn('IRC client connection is not active, cannot post message');
      return false;
    }

    const targetChannels = channels || this.config.channels;
    
    try {
      for (const channel of targetChannels) {
        this.client.say(channel, message);
        logger.info(`Posted message to IRC channel ${channel}: ${message.substring(0, 100)}...`);
      }
      return true;
    } catch (error) {
      logger.error('Failed to post message to IRC:', error);
      this.isConnected = false;
      this.attemptReconnect();
      return false;
    }
  }

  async postLiveNotification(showTitle, feedUrl) {
    const message = `🔴 LIVE NOW! ${showTitle} - Tune in: ${feedUrl} #LivePodcast #PC20 #PodPing`;
    
    return await this.postMessage(message);
  }

  startKeepAlive() {
    // Send periodic pings to keep connection alive and validate connection
    this.keepAliveInterval = setInterval(() => {
      if (this.isConnected && this.client && this.client.conn && this.client.conn.readyState === 'open') {
        try {
          // Check if client is still valid before sending ping
          if (this.client.conn && !this.client.conn.destroyed) {
            this.client.send('PING', 'keepalive');
            logger.debug('Sent keepalive ping to IRC server');
          } else {
            logger.warn('IRC client connection is destroyed, marking as disconnected');
            this.isConnected = false;
            this.attemptReconnect();
          }
        } catch (error) {
          logger.error('Failed to send keepalive ping:', error);
          this.isConnected = false;
          this.attemptReconnect();
        }
      } else if (!this.isConnected && this.reconnectAttempts < this.maxReconnectAttempts) {
        // Connection lost and we haven't hit max attempts, try to reconnect
        logger.warn('IRC connection lost during keepalive, attempting reconnect...');
        this.attemptReconnect();
      }
    }, 60000); // Send ping every 60 seconds
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  disconnect() {
    this.stopKeepAlive();
    this.reconnecting = false; // Stop any pending reconnections
    if (this.client) {
      this.client.removeAllListeners(); // Clean up event listeners
      this.client.disconnect();
      this.client = null;
    }
    this.isConnected = false;
  }

  isConnectionActive() {
    // More robust connection check
    if (!this.client || !this.isConnected) {
      return false;
    }
    
    // Check if client connection is still active
    try {
      return this.client.conn && this.client.conn.readyState === 'open';
    } catch (error) {
      logger.warn('Error checking IRC connection state:', error);
      return false;
    }
  }

  getStatus() {
    return {
      connected: this.isConnected,
      connectionActive: this.isConnectionActive(),
      reconnectAttempts: this.reconnectAttempts,
      channels: this.config.channels,
      server: this.config.server
    };
  }

  // Method to manually reset and reconnect
  resetAndReconnect() {
    logger.info('Manually resetting IRC connection and attempting fresh connection');
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.disconnect();
    setTimeout(() => {
      this.connect();
    }, 2000); // Wait 2 seconds before reconnecting
  }
} 