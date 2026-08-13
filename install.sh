#!/bin/bash
set -euo pipefail

[[ "$EUID" -ne 0 ]] || { echo "Run this installer as your normal user, without sudo." >&2; exit 1; }

repo="https://api.github.com/repos/wrick17/codex-stats/contents"
install_dir="$HOME/.local/share/codex-stats"
launch_agent="$HOME/Library/LaunchAgents/com.codex-stats.sync.plist"
log_file="$HOME/Library/Logs/codex-stats.log"
endpoint="${CODEX_STATS_URL:-https://codex-stats.pages.dev}"

command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh" >&2; exit 1; }
brew list bun >/dev/null 2>&1 || brew install bun </dev/null
bun_bin="$(brew --prefix)/bin/bun"

mkdir -p "$install_dir" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL -H 'Accept: application/vnd.github.raw+json' "$repo/agent/collector.js?ref=master" -o "$tmp_dir/collector.js"
curl -fsSL -H 'Accept: application/vnd.github.raw+json' "$repo/agent/enroll.js?ref=master" -o "$tmp_dir/enroll.js"
install -m 755 "$tmp_dir/collector.js" "$install_dir/collector.js"
install -m 755 "$tmp_dir/enroll.js" "$install_dir/enroll.js"

credential="$(security find-generic-password -a codex-stats -s codex-stats-ingest -w 2>/dev/null || true)"
if [[ "$credential" == v1.* ]] && CODEX_STATS_URL="$endpoint" "$bun_bin" "$install_dir/collector.js" --check; then
  :
else
  check_status=$?
  [[ "$credential" != v1.* || "$check_status" -eq 2 ]] || { echo "Could not validate the existing collector credential; try again later." >&2; exit 1; }
  CODEX_STATS_URL="$endpoint" "$bun_bin" "$install_dir/enroll.js"
fi
unset credential

default_name="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
system_name="${CODEX_STATS_SYSTEM:-$default_name}"
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }

cat >"$launch_agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codex-stats.sync</string>
  <key>ProgramArguments</key><array><string>$(xml_escape "$bun_bin")</string><string>$(xml_escape "$install_dir/collector.js")</string><string>--watch</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>CODEX_STATS_URL</key><string>$(xml_escape "$endpoint")</string>
    <key>CODEX_STATS_SYSTEM</key><string>$(xml_escape "$system_name")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$log_file")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$log_file")</string>
</dict></plist>
EOF

chmod 600 "$launch_agent"
plutil -lint "$launch_agent" >/dev/null
uid="$(id -u)"
launchctl bootout "gui/$uid" "$launch_agent" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$launch_agent"
launchctl kickstart -k "gui/$uid/com.codex-stats.sync"

echo "Codex Stats installed for '$system_name'. It will sync three minutes after Codex activity settles."
