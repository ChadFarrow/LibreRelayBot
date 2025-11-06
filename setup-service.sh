#!/bin/bash

# LibreRelayBot - 24/7 Service Setup Script

echo "🚀 Setting up LibreRelayBot for 24/7 operation..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2..."
    npm install -g pm2
fi

# Stop any existing instance
echo "🛑 Stopping existing instances..."
pm2 stop LibreRelayBot 2>/dev/null || true
pm2 delete LibreRelayBot 2>/dev/null || true

# Start with PM2
echo "▶️ Starting LibreRelayBot with PM2..."
pm2 start ecosystem.config.cjs

# Save PM2 configuration
echo "💾 Saving PM2 configuration..."
pm2 save

# Setup PM2 startup script for system reboots
echo "🔄 Setting up auto-start on system reboot..."
pm2 startup

echo ""
echo "✅ LibreRelayBot is now configured for 24/7 operation!"
echo ""
echo "📊 Management commands:"
echo "  pm2 status           - View status"
echo "  pm2 logs LibreRelayBot - View logs"
echo "  pm2 restart LibreRelayBot - Restart"
echo "  pm2 stop LibreRelayBot - Stop"
echo "  pm2 monit            - Real-time monitoring"
echo ""
echo "🌐 Web interfaces:"
echo "  Status: http://localhost:3336/status"
echo "  Health: http://localhost:3336/health"
echo ""