# Codex Field Notes

A private, consolidated Codex activity dashboard on Cloudflare Pages + D1.

Live dashboard: <https://codex-stats.pages.dev>

## One-line Mac installer

On any Mac with Homebrew—no `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/wrick17/codex-stats/master/install.sh | bash
```

The first Mac already has the collector secret in Keychain. On another Mac, the installer asks for it once and stores it in that Mac's Keychain. Retrieve it on an installed Mac with `security find-generic-password -a codex-stats -s codex-stats-ingest -w` and transfer it securely.

The installer is idempotent: rerun the same line to update the collector. It uses Homebrew's stable Bun path and a per-user LaunchAgent with `RunAtLoad`, so syncing survives logout, login, and reboot.

## What is collected

The collector reads `~/.codex/sessions` and `~/.codex/archived_sessions`, then sends only:

- session/time/system/repository labels
- Codex version, model, and reasoning effort
- token, turn, tool, error, and sub-agent counts
- tool names, never arguments or output

Prompts, responses, reasoning content, tool payloads, auth/config files, shell snapshots, and logs never leave the machine.

## Commands

```sh
bun install
bun test
bun run dev
```

Cloudflare:

```sh
bun run db:remote
bun run deploy -- --branch master
```

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
