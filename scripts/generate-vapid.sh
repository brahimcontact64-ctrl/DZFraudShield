#!/usr/bin/env bash
# Generate a VAPID key pair for Web Push notifications.
# Paste the output into your .env.local / Vercel environment variables.
#
# WARNING: Rotating VAPID keys invalidates all existing push subscriptions.

set -euo pipefail

echo "Generating VAPID key pair..."
npx web-push generate-vapid-keys
echo ""
echo "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in your environment."
echo "Never commit the private key to version control."
