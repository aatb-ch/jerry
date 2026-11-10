#!/bin/sh
# Upload all git-tracked files over FTPS (explicit TLS) to the server configured in .env (never committed).
# TLS 1.2: macOS curl + TLS 1.3 makes the server abort bigger uploads (450).
# Only uploads, never deletes: saved programs in db/ on the server are untouched.
set -e
cd "$(dirname "$0")"
# Read .env literally (values may contain spaces; no shell evaluation, optional surrounding quotes stripped).
while IFS='=' read -r k v; do
  case "$k" in FTP_*) v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}; eval "$k=\$v" ;; esac
done < .env
git ls-files | grep -vE '^(docs/|deploy\.sh|dev_server\.py|\.gitignore)' | while read -r f; do
  echo "$f"
  curl -sS --ssl-reqd --tls-max 1.2 --ftp-create-dirs -T "$f" --user "$FTP_USER:$FTP_PASS" "ftp://$FTP_HOST:${FTP_PORT:-21}${FTP_DIR%/}/$f" || echo "  FAILED: $f"
done
