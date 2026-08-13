#!/bin/bash
set -euo pipefail

[[ "$EUID" -ne 0 ]] || { echo "Run this installer as your normal user, without sudo." >&2; exit 1; }

repo="https://raw.githubusercontent.com/wrick17/codex-stats/master"
install_dir="$HOME/.local/share/codex-stats"
launch_agent="$HOME/Library/LaunchAgents/com.codex-stats.sync.plist"
log_file="$HOME/Library/Logs/codex-stats.log"

command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh" >&2; exit 1; }
brew list bun >/dev/null 2>&1 || brew install bun
bun_bin="$(brew --prefix)/bin/bun"

mkdir -p "$install_dir" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$repo/agent/collector.js" -o "$tmp"
install -m 755 "$tmp" "$install_dir/collector.js"

if ! security find-generic-password -a codex-stats -s codex-stats-ingest >/dev/null 2>&1; then
  token="${CODEX_STATS_TOKEN:-}"
  if [[ -z "$token" ]]; then
    printf 'Collector secret: ' >/dev/tty
    IFS= read -rs token </dev/tty
    printf '\n' >/dev/tty
  fi
  [[ -n "$token" ]] || { echo "Collector secret is required" >&2; exit 1; }
  security add-generic-password -a codex-stats -s codex-stats-ingest -w "$token" -U >/dev/null
fi

default_name="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
system_name="${CODEX_STATS_SYSTEM:-$default_name}"
endpoint="${CODEX_STATS_URL:-https://codex-stats.pages.dev}"
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
