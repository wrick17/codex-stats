# Codex Field Notes

A private, consolidated Codex activity dashboard on Cloudflare Pages + D1.

Live dashboard: <https://codex-stats.pages.dev>

## Set up a Mac

Prerequisites: macOS, Homebrew, and Codex run at least once. The installation is entirely per-user and never needs `sudo`.

1. On an already-connected Mac, copy the shared collector secret:

   ```sh
   security find-generic-password -a codex-stats -s codex-stats-ingest -w | pbcopy
   ```

2. On the new Mac, run the one-line installer and paste that secret when prompted:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/wrick17/codex-stats/master/install.sh | bash
   ```

3. Verify the per-user background service:

   ```sh
   launchctl print "gui/$(id -u)/com.codex-stats.sync"
   tail -f "$HOME/Library/Logs/codex-stats.log"
   ```

The installer stores the secret in that Mac's Keychain, uses the Mac's Computer Name as its dashboard label, installs Bun through Homebrew if needed, and creates a LaunchAgent under `~/Library/LaunchAgents`. Rerun the same one-liner at any time to update or repair the collector. To override the label, use `curl -fsSL https://raw.githubusercontent.com/wrick17/codex-stats/master/install.sh | CODEX_STATS_SYSTEM='My Mac' bash`.

The installer is idempotent: rerun the same line to update the collector. It uses Homebrew's stable Bun path and a per-user LaunchAgent with `RunAtLoad` and `KeepAlive`, so it restarts after failure and resumes at login after a reboot. A native filesystem watcher waits three minutes after the latest Codex session change, sends all changed aggregates in one request, and retries pending failures every five minutes; idle Macs send nothing. Stored historical sessions missing from sync state are recovered once through the same durable queue.

The dashboard never polls; it loads only when opened, filtered, or manually refreshed. Its API-equivalent cost estimate uses OpenAI's standard token rates, fetched server-side at most once per active day, cached in D1, and reused if the pricing source is temporarily unavailable.

## What is collected

The collector reads `~/.codex/sessions` and `~/.codex/archived_sessions`, then sends only:

- session/time/system/repository labels
- Codex version, model, and reasoning effort
- token, turn, tool, error, and sub-agent counts
- loaded skill names and counts, never skill contents

Prompts, responses, reasoning content, tool payloads, auth/config files, shell snapshots, and logs never leave the machine.

## Commands

```sh
bun install
bun test
bun run dev
```

Production releases are push-driven; do not run production Wrangler commands locally. A push to `master` triggers GitHub Actions to test, compile the Pages Functions bundle, apply pending D1 migrations, and deploy `public/` plus `functions/` together to the existing Cloudflare Pages project.

One-time release setup:

- Add GitHub Actions secrets named `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Scope the token to this Cloudflare account with D1 Edit and Pages Write permissions.
- Keep the Pages `DB` binding, `OWNER_EMAIL` variable, and `INGEST_TOKEN` secret configured for production.

Run a collector once:

```sh
CODEX_STATS_URL=https://codex-stats.pages.dev \
CODEX_STATS_TOKEN='<shared ingest secret>' \
CODEX_STATS_SYSTEM='My Mac' \
bun agent/collector.js
```

On macOS, store the token in Keychain instead of an environment file:

```sh
security add-generic-password -a codex-stats -s codex-stats-ingest -w '<shared ingest secret>' -U
```

For development, `agent/com.codex-stats.sync.plist.example` is the equivalent manual LaunchAgent template.

## Configuration

- `OWNER_EMAIL` in `wrangler.jsonc` is the only Shoo identity allowed to read stats.
- `INGEST_TOKEN` is a Cloudflare Pages secret. Collectors HMAC-sign every request with it.
- The current machine keeps the same secret in macOS Keychain under service `codex-stats-ingest`.
