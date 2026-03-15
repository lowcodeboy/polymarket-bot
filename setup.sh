#!/bin/bash
# Run this script on the AWS server after cloning the repo

set -e

echo "=== Installing Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "=== Installing pm2 ==="
sudo npm install -g pm2

echo "=== Installing dependencies ==="
npm install

echo "=== Building TypeScript ==="
npm run build

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Copy your .env file:  nano .env"
echo "  2. Start the bot:        pm2 start ecosystem.config.js"
echo "  3. Check logs:           pm2 logs"
echo "  4. Auto-start on reboot: pm2 startup && pm2 save"
