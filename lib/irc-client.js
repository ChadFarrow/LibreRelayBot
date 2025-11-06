import irc from 'irc';
import { logger } from './logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import net from 'net';

const execAsync = promisify(exec);

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
    this.zncHealthInterval = null;
  }

  async connect() {
    // Clean up existing connection and intervals
    this.disconnect();

    // Connect directly to IRC server (bypassing ZNC for now)
    const server = this.config.server || 'irc.zeronode.net';
    const port = this.config.port || 6667;
    const secure = this.config.secure || false;

    logger.info('Connecting directly to IRC server...', {
      server: server,
      port: port,
      secure: secure,
      channels: this.config.channels,
      nickname: this.config.nickname
    });

    this.client = new irc.Client(server, this.config.nickname, {
      port: port,
      secure: secure,
      selfSigned: false,
      certExpired: false,
      autoRejoin: true,
      autoConnect: true,
      channels: this.config.channels,
      realName: this.config.realName || 'LibreRelayBot Reader Bot',
      userName: this.config.userName || 'boost_reader',
      retryCount: 0, // Disable built-in retry to avoid conflicts
      retryDelay: 5000,
      floodProtection: true,
      floodProtectionDelay: 1000,
      messageSplit: 512,
      stripColors: true,
      encoding: 'utf8',
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
      // this.startZncHealthCheck(); // Not needed for direct IRC connection
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
      if (this.isConnected && this.client) {
        try {
          this.client.send('PING', 'keepalive');
          logger.debug('Sent keepalive ping to IRC server');
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

  // ZNC Health Check Methods
  async checkZncHealth() {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 5000);

      socket.connect(6697, 'localhost', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  async ensureZncRunning() {
    try {
      const isHealthy = await this.checkZncHealth();
      if (!isHealthy) {
        logger.warn('ZNC is not responding, attempting to restart...');
        const { stdout, stderr } = await execAsync('/home/server/bots/BoostAfterBoost/start-znc.sh');
        if (stderr) {
          logger.error('ZNC restart stderr:', stderr);
        }
        logger.info('ZNC restart attempt completed:', stdout);
        
        // Wait a moment and check again
        await new Promise(resolve => setTimeout(resolve, 5000));
        const isHealthyNow = await this.checkZncHealth();
        if (!isHealthyNow) {
          logger.error('ZNC still not responding after restart attempt');
          return false;
        }
        logger.info('ZNC is now responding after restart');
      }
      return true;
    } catch (error) {
      logger.error('Error ensuring ZNC is running:', error);
      return false;
    }
  }

  startZncHealthCheck() {
    // Check ZNC health every 2 minutes
    this.zncHealthInterval = setInterval(async () => {
      try {
        const isHealthy = await this.ensureZncRunning();
        if (!isHealthy && this.isConnected) {
          logger.warn('ZNC health check failed, may need to reconnect IRC');
          // Don't force reconnection here, let the IRC library handle it
        }
      } catch (error) {
        logger.error('Error in ZNC health check:', error);
      }
    }, 120000); // 2 minutes
  }

  stopZncHealthCheck() {
    if (this.zncHealthInterval) {
      clearInterval(this.zncHealthInterval);
      this.zncHealthInterval = null;
    }
  }

  disconnect() {
    this.stopKeepAlive();
    this.stopZncHealthCheck();
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