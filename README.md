# Codex Field Notes

A private, consolidated Codex activity dashboard on Cloudflare Pages + D1.

Live dashboard: <https://codex-stats.wrick17.com>

## Set up a Mac

Prerequisites: macOS, Homebrew, Codex run at least once, and access to the allowed Google account. The installation is entirely per-user and never needs `sudo`.

1. Run the one-line installer:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/wrick17/codex-stats/master/install.sh | bash
   ```

2. Sign in as `wrick17@gmail.com` in the browser window opened by the installer, then verify the per-user background service:

   ```sh
   launchctl print "gui/$(id -u)/com.codex-stats.sync"
   tail -f "$HOME/Library/Logs/codex-stats.log"
   ```

After server-side Shoo verification, the installer stores a user-bound collector credential in that Mac's Keychain, uses the Mac's Computer Name as its dashboard label, installs Bun through Homebrew if needed, and creates a LaunchAgent under `~/Library/LaunchAgents`. Rerun the same one-liner at any time to update or repair the collector. To override the label, use `curl -fsSL https://raw.githubusercontent.com/wrick17/codex-stats/master/install.sh | CODEX_STATS_SYSTEM='My Mac' bash`.

Open <http://127.0.0.1:47821> on the Mac to see the collector status or trigger an immediate full reconciliation. Manual sync checks every discovered historical session and uploads only records missing or older on the server.

The installer is idempotent: rerun the same line to update the collector. It uses Homebrew's stable Bun path and a per-user LaunchAgent with `RunAtLoad` and `KeepAlive`, so it restarts after failure and resumes at login after a reboot. On first enrollment it uploads historical aggregates; on later starts or reinstalls it sends timestamps first and uploads only sessions missing or older on the server. A native filesystem watcher syncs at most once every three minutes while Codex is changing. Each active sync also checks one rotating batch of 100 historical timestamps and immediately repairs server gaps; one failed cycle is retried after five minutes, then the collector waits for new activity or a manual sync. Idle Macs send nothing.

The dashboard never polls; it loads only when opened, filtered, or manually refreshed. Its API-equivalent cost estimate uses OpenAI's standard token rates, fetched server-side at most once per active day, cached in D1, and reused if the pricing source is temporarily unavailable.

## What is collected

The collector reads `~/.codex/sessions` and `~/.codex/archived_sessions`, then sends only:

- session/time/system/repository labels
- Codex version, model, and reasoning effort
- token, turn, tool, error, and sub-agent counts
- loaded skill names and counts, never skill contents
- weekly Codex usage-limit percentage remaining and reset time from OpenAI

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

Run a previously enrolled collector once:

```sh
CODEX_STATS_URL=https://codex-stats.wrick17.com \
CODEX_STATS_TOKEN='<user-bound collector credential>' \
CODEX_STATS_SYSTEM='My Mac' \
bun agent/collector.js
```

The installer stores the credential in Keychain on macOS:

```sh
security find-generic-password -a codex-stats -s codex-stats-ingest
```

For development, `agent/com.codex-stats.sync.plist.example` is the equivalent manual LaunchAgent template.

## Configuration

- `OWNER_EMAIL` in `wrangler.jsonc` is the only Shoo identity currently allowed to enroll collectors or read stats.
- Every system and session row is keyed by its verified owner email; dashboard queries always include that owner boundary.
- `INGEST_TOKEN` is a Cloudflare Pages-only signing secret. It issues user-bound collector credentials and never leaves the backend.
- Each enrolled Mac keeps its credential in Keychain under service `codex-stats-ingest` and HMAC-signs every upload.
