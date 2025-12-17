// libre-relay-bot.js - IRC to Nostr bridge for monitoring LibreRelayBot
import express from 'express';
import dotenv from 'dotenv';
import { finalizeEvent, nip19 } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import { logger } from './lib/logger.js';
import { IRCClient } from './lib/irc-client.js';

// Configure environment variables
dotenv.config();

// Configuration with validation
class Config {
  constructor() {
    this.irc = {
      server: process.env.IRC_SERVER || 'irc.zeronode.net',
      port: this.parsePort(process.env.IRC_PORT) || 6667,
      secure: process.env.IRC_SECURE === 'true',
      nickname: process.env.IRC_NICKNAME || 'LibreRelayBot_Reader',
      userName: process.env.IRC_USERNAME || 'libre_reader',
      realName: process.env.IRC_REALNAME || 'LibreRelayBot Reader Bot',
      password: process.env.IRC_PASSWORD,
      channels: [process.env.IRC_CHANNEL || '#SirLibre']
    };
    
    this.nostr = {
      nsec: process.env.NOSTR_NSEC,
      relays: this.parseRelays(process.env.NOSTR_RELAYS)
    };
    
    this.app = {
      port: this.parsePort(process.env.PORT) || 3336,
      testMode: process.env.TEST_MODE === 'true',
      targetBot: process.env.TARGET_BOT || 'LibreRelayBot'
    };
  }

  parsePort(value) {
    const port = parseInt(value);
    return isNaN(port) || port < 1 || port > 65535 ? null : port;
  }

  parseRelays(value) {
    if (!value) {
      return ['wss://relay.damus.io', 'wss://relay.nostr.band', 'wss://nostr.mom', 'wss://relay.primal.net', 'wss://chadf.nostr1.com'];
    }
    return value.split(',').map(relay => relay.trim()).filter(Boolean);
  }

  validate() {
    const errors = [];
    if (!this.nostr.nsec || this.nostr.nsec === 'your_nostr_private_key_here') {
      errors.push('NOSTR_NSEC is required and must be a valid nsec key');
    }
    if (!this.nostr.nsec?.startsWith('nsec1') || this.nostr.nsec.length !== 63) {
      errors.push('NOSTR_NSEC must be a valid nsec1 format');
    }
    return errors;
  }
}

// Security utilities
class Security {
  static sanitizeMessage(message) {
    if (typeof message !== 'string') return '';
    return message
      .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
      .trim()
      .substring(0, 280); // Limit message length
  }

  static createRateLimiter(maxRequests = 5, windowMs = 60000) {
    const requests = new Map();
    
    return (key) => {
      const now = Date.now();
      const windowStart = now - windowMs;
      
      if (!requests.has(key)) {
        requests.set(key, []);
      }
      
      const userRequests = requests.get(key);
      // Remove old requests
      while (userRequests.length && userRequests[0] < windowStart) {
        userRequests.shift();
      }
      
      if (userRequests.length >= maxRequests) {
        return false;
      }
      
      userRequests.push(now);
      return true;
    };
  }
}

// Enhanced Nostr client
class NostrClient {
  constructor(nsec, relays, testMode = false) {
    this.nsec = nsec;
    this.relays = relays;
    this.testMode = testMode;
    this.secretKey = this._getSecretKey();
  }

  _getSecretKey() {
    try {
      const { data } = nip19.decode(this.nsec);
      return data;
    } catch (error) {
      throw new Error(`Invalid nsec format: ${error.message}`);
    }
  }

  async publishMessage(content, tags = []) {
    const event = finalizeEvent({
      kind: 1,
      content,
      tags: [
        ['t', 'sirlibre'],
        ['t', 'librerelaybot'],
        ...tags
      ],
      created_at: Math.floor(Date.now() / 1000),
    }, this.secretKey);

    if (this.testMode) {
      logger.info('TEST MODE - Would publish:', { content, tags, relays: this.relays });
      return { success: true, published: 0, failed: 0 };
    }

    return await this._publishToRelays(event);
  }

  async _publishToRelays(event) {
    const results = await Promise.allSettled(
      this.relays.map(url => this._publishToRelay(url, event))
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    logger.info(`Published to ${successful}/${this.relays.length} relays`);
    return { success: successful > 0, published: successful, failed };
  }

  async _publishToRelay(url, event) {
    const relay = await Relay.connect(url);
    try {
      await relay.publish(event);
      logger.debug(`Published to ${url}`);
      return url;
    } finally {
      relay.close();
    }
  }
}

// Main application class
class LibreRelayBotBridge {
  constructor() {
    this.config = new Config();
    this.stats = this._initStats();
    this.ircClient = null;
    this.nostrClient = null;
    this.rateLimiter = Security.createRateLimiter(5, 60000);
    this._setupGlobalErrorHandlers();
  }

  _initStats() {
    return {
      startTime: new Date(),
      messagesMonitored: 0,
      successfulPosts: 0,
      failedPosts: 0,
      lastActivity: null,
      relayStats: {}
    };
  }

  _setupGlobalErrorHandlers() {
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', { error: error.message, stack: error.stack });
      
      // Don't exit immediately on IRC-related errors - try to recover
      if (error.message && error.message.includes('Cannot read properties of null')) {
        logger.warn('Detected IRC library null reference error, attempting recovery...');
        setTimeout(() => {
          if (this.ircClient) {
            this.ircClient.resetAndReconnect();
          }
        }, 5000);
        return;
      }
      
      this._gracefulShutdown(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection:', { reason, promise });
      
      // Don't crash on promise rejections - log and continue
      if (reason && typeof reason === 'object' && reason.message) {
        logger.warn('Handling promise rejection gracefully:', reason.message);
      }
    });

    ['SIGINT', 'SIGTERM'].forEach(signal => {
      process.on(signal, () => this._gracefulShutdown(0));
    });
  }

  async start() {
    try {
      const validationErrors = this.config.validate();
      if (validationErrors.length > 0) {
        logger.error('Configuration errors:', validationErrors);
        process.exit(1);
      }

      this._initializeNostrClient();
      await this._initializeIRCClient();
      this._startWebServer();
      
      logger.info('🚀 LibreRelayBot bridge started successfully');
    } catch (error) {
      logger.error('Failed to start bridge:', error);
      process.exit(1);
    }
  }

  _initializeNostrClient() {
    try {
      this.nostrClient = new NostrClient(
        this.config.nostr.nsec,
        this.config.nostr.relays,
        this.config.app.testMode
      );
      logger.info('✅ Nostr client initialized');
    } catch (error) {
      logger.error('❌ Failed to initialize Nostr client:', error);
      throw error;
    }
  }

  async _initializeIRCClient() {
    try {
      this.ircClient = new IRCClient(this.config.irc);
      
      // Enhanced message handler with error catching
      const originalConnect = this.ircClient.connect.bind(this.ircClient);
      this.ircClient.connect = async () => {
        await originalConnect();
        
        if (this.ircClient.client) {
          this.ircClient.client.on('message', async (from, to, message) => {
            try {
              await this._handleIRCMessage(from, to, message);
            } catch (error) {
              logger.error('Error handling IRC message:', error);
            }
          });
          
          logger.info(`🎯 Monitoring ${this.config.app.targetBot} in ${this.config.irc.channels[0]}`);
        }
      };
      
      await this.ircClient.connect();
    } catch (error) {
      logger.error('❌ Failed to initialize IRC client:', error);
      throw error;
    }
  }

  async _handleIRCMessage(from, to, message) {
    // Only monitor messages from the target bot
    if (from !== this.config.app.targetBot) {
      return;
    }

    logger.info(`📨 Message from ${from}:`, message);
    this.stats.messagesMonitored++;
    this.stats.lastActivity = new Date();

    // Rate limiting
    if (!this.rateLimiter(from)) {
      logger.warn(`⚠️ Rate limit exceeded for ${from}`);
      return;
    }

    // Post to Nostr
    if (this.nostrClient) {
      await this._postToNostr(message);
    }
  }

  async _postToNostr(message) {
    try {
      const sanitizedMessage = Security.sanitizeMessage(message);
      if (!sanitizedMessage) {
        logger.warn('Empty message after sanitization, skipping');
        return;
      }

      const result = await this.nostrClient.publishMessage(sanitizedMessage);
      
      if (result.success) {
        this.stats.successfulPosts++;
        logger.info(`✅ Posted to Nostr: ${sanitizedMessage.substring(0, 50)}...`);
      } else {
        this.stats.failedPosts++;
        logger.error('❌ Failed to post to any Nostr relays');
      }
    } catch (error) {
      this.stats.failedPosts++;
      logger.error('❌ Error posting to Nostr:', error);
    }
  }

  _startWebServer() {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    
    // Security headers
    app.use((req, res, next) => {
      res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block'
      });
      next();
    });

    app.get('/health', (req, res) => {
      const healthy = this.ircClient?.isConnected && this.nostrClient;
      res.status(healthy ? 200 : 503).json({
        status: healthy ? 'healthy' : 'unhealthy',
        uptime: process.uptime(),
        connected: this.ircClient?.isConnected || false,
        timestamp: new Date().toISOString()
      });
    });

    app.get('/status', (req, res) => {
      const uptimeSeconds = Math.floor((Date.now() - this.stats.startTime) / 1000);
      res.json({
        ...this.stats,
        uptime: uptimeSeconds,
        irc: {
          connected: this.ircClient?.isConnected || false,
          server: this.config.irc.server,
          channels: this.config.irc.channels,
          monitoring: this.config.app.targetBot
        },
        nostr: {
          configured: !!this.nostrClient,
          relays: this.config.nostr.relays,
          testMode: this.config.app.testMode
        }
      });
    });

    app.listen(this.config.app.port, () => {
      logger.info(`🌐 Web server running on port ${this.config.app.port}`);
      logger.info(`📊 Status: http://localhost:${this.config.app.port}/status`);
      logger.info(`💚 Health: http://localhost:${this.config.app.port}/health`);
    });
  }

  _gracefulShutdown(exitCode = 0) {
    logger.info('🛑 Shutting down gracefully...');
    
    if (this.ircClient) {
      try {
        this.ircClient.disconnect();
        logger.info('IRC client disconnected');
      } catch (error) {
        logger.error('Error disconnecting IRC client:', error);
      }
    }
    
    setTimeout(() => {
      logger.info('Shutdown complete');
      process.exit(exitCode);
    }, 1000);
  }
}

// Start the bridge
const bridge = new LibreRelayBotBridge();
bridge.start().catch(error => {
  logger.error('❌ Failed to start bridge:', error);
  process.exit(1);
});

