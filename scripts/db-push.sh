#!/usr/bin/env bash
# Apply all Supabase migrations to the linked project.
# Usage: bash scripts/db-push.sh
#
# Prerequisites:
#   npm install -g supabase
#   supabase login
#   supabase link --project-ref <ref>

set -euo pipefail

echo "Applying database migrations..."
supabase db push

echo "Done."
