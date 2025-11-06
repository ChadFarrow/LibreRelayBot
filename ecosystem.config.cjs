module.exports = {
  apps: [{
    name: 'LibreRelayBot',
    script: 'libre-relay-bot.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3337
    },
    error_file: './logs/libre-relay-bot-error.log',
    out_file: './logs/libre-relay-bot-out.log',
    log_file: './logs/libre-relay-bot-combined.log',
    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    kill_timeout: 3000,
    listen_timeout: 8000,
    shutdown_with_message: true,
    restart_delay: 2000,
    max_restarts: 10,
    min_uptime: '10s'
  }]
}