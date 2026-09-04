#!/bin/sh
set -eu

readonly resources="/opt/TraceForge/resources"
readonly native_source="$resources/native/linux-x64"
readonly deployment_source="$resources/linux-deployment"
readonly install_root="/usr/lib/traceforge"
readonly profile_name="usr.lib.traceforge.traceforge-linux-sandbox"
readonly profile_path="/etc/apparmor.d/$profile_name"

[ -x "$native_source/traceforge-linux-sandbox" ]
[ -f "$native_source/release.json" ]
[ -f "$deployment_source/apparmor/$profile_name" ]
[ -x "$deployment_source/traceforge-sandboxed" ]
command -v apparmor_parser >/dev/null 2>&1
command -v systemd-run >/dev/null 2>&1

install -d -o root -g root -m 0755 "$install_root"
backup_root=$(mktemp -d "$install_root/.install-backup.XXXXXX")
had_helper=0
had_manifest=0
had_profile=0
had_launcher=0
[ ! -e "$install_root/traceforge-linux-sandbox" ] || { cp -p "$install_root/traceforge-linux-sandbox" "$backup_root/helper"; had_helper=1; }
[ ! -e "$install_root/release.json" ] || { cp -p "$install_root/release.json" "$backup_root/manifest"; had_manifest=1; }
[ ! -e "$profile_path" ] || { cp -p "$profile_path" "$backup_root/profile"; had_profile=1; }
[ ! -e /usr/bin/traceforge ] || { cp -p /usr/bin/traceforge "$backup_root/launcher"; had_launcher=1; }

committed=0
rollback() {
  [ "$committed" -eq 0 ] || return 0
  if [ "$had_helper" -eq 0 ]; then rm -f "$install_root/traceforge-linux-sandbox"; else cp -p "$backup_root/helper" "$install_root/traceforge-linux-sandbox"; fi
  if [ "$had_manifest" -eq 0 ]; then rm -f "$install_root/release.json"; else cp -p "$backup_root/manifest" "$install_root/release.json"; fi
  if [ "$had_profile" -eq 0 ]; then rm -f "$profile_path"; else cp -p "$backup_root/profile" "$profile_path"; fi
  if [ "$had_launcher" -eq 0 ]; then rm -f /usr/bin/traceforge; else cp -p "$backup_root/launcher" /usr/bin/traceforge; fi
  if [ -f "$profile_path" ]; then apparmor_parser -r "$profile_path" >/dev/null 2>&1 || true; fi
}
cleanup() { rm -rf "$backup_root"; }
trap 'rollback; cleanup' EXIT HUP INT TERM

install -o root -g root -m 0755 "$native_source/traceforge-linux-sandbox" "$install_root/.traceforge-linux-sandbox.new"
install -o root -g root -m 0644 "$native_source/release.json" "$install_root/.release.json.new"
mv -f "$install_root/.traceforge-linux-sandbox.new" "$install_root/traceforge-linux-sandbox"
mv -f "$install_root/.release.json.new" "$install_root/release.json"

install -o root -g root -m 0644 "$deployment_source/apparmor/$profile_name" "$profile_path.new"
mv -f "$profile_path.new" "$profile_path"
apparmor_parser -r "$profile_path"

install -o root -g root -m 0755 "$deployment_source/traceforge-sandboxed" /usr/bin/traceforge
committed=1
cleanup
trap - EXIT HUP INT TERM
