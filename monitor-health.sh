#!/bin/bash

# LibreRelayBot Health Monitor
# Checks if the bot is running and responsive, restarts if needed

BOT_DIR="/home/server/LibreRelayBot"
BOT_SCRIPT="libre-relay-bot.js"
PORT=3337
LOG_FILE="$BOT_DIR/monitor.log"

# Function to log with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Function to check if bot process is running
is_process_running() {
    pgrep -f "$BOT_SCRIPT" > /dev/null
    return $?
}

# Function to check if bot is responsive via HTTP
is_bot_responsive() {
    local response_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health" 2>/dev/null)
    [[ "$response_code" == "200" ]]
    return $?
}

# Function to check IRC connection status
is_irc_connected() {
    local status=$(curl -s "http://localhost:$PORT/status" 2>/dev/null | jq -r '.irc.connected' 2>/dev/null)
    [[ "$status" == "true" ]]
    return $?
}

# Function to start the bot
start_bot() {
    log "Starting LibreRelayBot..."
    cd "$BOT_DIR"
    nohup node "$BOT_SCRIPT" > libre-relay-bot.log 2>&1 &
    sleep 5
    
    if is_process_running; then
        log "✅ Bot started successfully"
        return 0
    else
        log "❌ Failed to start bot"
        return 1
    fi
}

# Function to restart the bot
restart_bot() {
    log "Restarting LibreRelayBot..."
    
    # Kill existing processes
    pkill -f "$BOT_SCRIPT" 2>/dev/null
    sleep 3
    
    # Force kill if still running
    pkill -9 -f "$BOT_SCRIPT" 2>/dev/null
    sleep 2
    
    # Start the bot
    start_bot
}

# Main monitoring logic
main() {
    log "🔍 Starting health check..."
    
    # Check if process is running
    if ! is_process_running; then
        log "❌ Bot process is not running"
        start_bot
        return
    fi
    
    # Check if bot is responsive
    if ! is_bot_responsive; then
        log "❌ Bot is not responsive via HTTP"
        restart_bot
        return
    fi
    
    # Check if IRC is connected
    if ! is_irc_connected; then
        log "❌ IRC connection is down"
        restart_bot
        return
    fi
    
    log "✅ Bot is healthy and operational"
}

# Run the health check
main

# Optional: Clean up old log entries (keep last 1000 lines)
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt 1000 ]]; then
    tail -1000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi