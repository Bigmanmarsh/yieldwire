#!/bin/sh
# YieldWire — one-time push. Run from inside the extracted yieldwire/ folder.
# If your machine uses SSH for GitHub: no changes needed.
# If you use HTTPS, change the origin line to:
#   git remote add origin https://github.com/Bigmanmarsh/yieldwire.git
set -e
[ -d .git ] || git init -b main
git add -A
git commit -m "YieldWire v0.1 — first public run"
git remote add origin git@github.com:Bigmanmarsh/yieldwire.git 2>/dev/null || git remote set-url origin git@github.com:Bigmanmarsh/yieldwire.git
git push -u origin main
echo "Pushed. Next: set repo Secrets (TG_BOT_TOKEN, TG_CHAT_ID) and enable Pages."
