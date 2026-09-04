#!/bin/sh
set -eu

case "${1:-remove}" in
  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear)
    exit 0
    ;;
esac

readonly profile_path="/etc/apparmor.d/usr.lib.traceforge.traceforge-linux-sandbox"
if [ -f "$profile_path" ] && command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser -R "$profile_path" >/dev/null 2>&1 || true
fi
rm -f /usr/bin/traceforge
rm -f "$profile_path"
rm -f /usr/lib/traceforge/traceforge-linux-sandbox /usr/lib/traceforge/release.json
rmdir /usr/lib/traceforge 2>/dev/null || true
