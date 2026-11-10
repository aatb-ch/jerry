#!/bin/sh
# Upload all git-tracked files to the FTP server configured in .env (never committed).
set -e
cd "$(dirname "$0")"
. ./.env
git ls-files | while read -r f; do
  echo "$f"
  curl -sS --ftp-create-dirs -T "$f" --user "$FTP_USER:$FTP_PASS" "ftp://$FTP_HOST:${FTP_PORT:-21}${FTP_DIR%/}/$f"
done
