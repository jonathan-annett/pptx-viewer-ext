# Handover — pptx-viewer-ext (VPS → phone-dev, 2026-05-17)

You're a Claude instance running on the user's phone (Termux/Android). The
previous handover (Linux → VPS, the contents of this file before this commit)
is complete: the extension is now running on a Linux VPS, reachable over
public HTTPS, and the dev loop is set up to pull source changes from this
repo automatically. This file replaces the old handover with the current
state of play and how *you* can ship extension changes from the phone.

If you need the Linux→VPS handover for historical context, it's in
`git log -p -- HANDOVER.md` before commit `c229dfc`.

## Repo

- GitHub: `jonathan-annett/pptx-viewer-ext` (public)
- Branch: `main`. Latest commit `c229dfc` ("Add reverse-proxy support and pm2
  dev workflow").
- Latest release tag: `v0.0.3` with `.vsix` attached — unchanged since the
  previous handover.

What changed since the last handover (all on `main`):

| Commit | What it added |
|---|---|
| `c229dfc` | `scripts/fix-koa-proxy.cjs`, wiring in `package.json`, `ecosystem.config.cjs` |

That's it from a code perspective. The five `src/*.ts` files are unchanged.
**No behaviour or parser changes.** Everything else from this session lives
in `/etc/` on the VPS and isn't in the repo (see Infrastructure below).

## Current state

**Live URL**: <https://vscode.sophtwhere.com>

The VS Code Web shell loads and is reachable over public HTTPS. A real
`.pptx` file opens the **Pptx Info** custom editor; the webview iframe is
served from a per-instance UUID subdomain under `*.vscode.sophtwhere.com`
(VS Code Web's standard isolation pattern). DNS, certs, and reverse-proxy
all work end-to-end.

**Verification status**: The user has confirmed the **editor shell loads**
in a browser. They have **not yet formally signed off** that a real `.pptx`
renders correctly inside the webview after the wildcard-cert fix landed.
Treat the README's "What it shows" / HANDOVER's old "First priority" list
as **still partially open** — when the user is ready, they should:

1. Open a real `.pptx` via the file explorer in the live URL.
2. Confirm the Pptx Info editor takes over (not "binary file").
3. Confirm metadata fields and the three validation flags fire correctly.
4. Confirm `[pptx-viewer]`-prefixed logs appear in *View → Output → Pptx Info*
   and in the browser DevTools console.

If anything looks off, that's the next thing for you to investigate.

## How to deploy extension changes from the phone

The dev environment on the VPS is structured so source-only changes flow
through automatically. The loop:

1. **You (on the phone)**: edit `src/*.ts`, commit, **push to origin**.
2. **User**: SSH to the VPS, run `git pull` inside `/home/jonathan/pptx-viewer-ext`.
3. **VPS** (automatic): `pptx-watch` (esbuild `--watch` running under pm2)
   sees the file change via inotify and rebuilds `dist/extension.js` in ~20ms.
4. **User**: hard-reload the browser tab on `vscode.sophtwhere.com`. New code
   runs.

That's the 90% path. Three exceptions require an extra step on the VPS:

| If the diff touches… | User needs to also run |
|---|---|
| `package.json` deps or `package-lock.json` | `npm install` |
| `scripts/*.cjs` preloads, or any `package.json` `scripts` entry | `pm2 restart pptx-dev-server` |
| Both of the above | both, in that order |

**Things to keep in mind when committing from the phone:**

- `dist/` is gitignored. Don't commit a local build; the VPS rebuilds from `src/`.
- Don't touch `.vscode-test-web/` — it's gitignored and only relevant on the VPS.
- The two Termux preload scripts (`scripts/fix-cpus.cjs`, `scripts/fix-platform.cjs`)
  still no-op on Linux, so they cost nothing. Don't remove them — the user is
  still iterating on the phone and they're needed there.
- A **third** preload script now exists, `scripts/fix-koa-proxy.cjs`. This one
  is **only useful when test-web sits behind a reverse proxy** (the VPS case).
  On Termux it does nothing harmful — `process.connection.encrypted` is false
  and `X-Forwarded-Proto` is absent, so it falls through to `http`. Keep it.
- The `open-in-browser` script now preloads both `fix-platform.cjs` AND
  `fix-koa-proxy.cjs`. If you ever rewrite the script, preserve both `--require`
  flags.

**Where to push your changes:** `origin/main`. There's no PR workflow; the
user is comfortable pushing directly to main on this repo since they're the
only contributor.

**Commit message style** (from `git log`): "Add X for Y" / "Fix X". Recent
examples in the log will guide you. The user explicitly approved the
`Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` trailer.

## Infrastructure (NOT in this repo)

Everything that makes the live URL work lives on the VPS at
`/home/jonathan/pptx-viewer-ext-INFRASTRUCTURE.md`. You don't need it for
extension work — but if you SSH in and want context for what you're seeing,
read that file. High-level layout:

- **Caddy** (system unit) terminates TLS for both `vscode.sophtwhere.com`
  and `*.vscode.sophtwhere.com`, reverse-proxies to `127.0.0.1:3001`.
  Apex cert auto-renewed by Caddy via HTTP-01; wildcard cert auto-renewed
  by certbot via a self-hosted **acme-dns** instance (system unit, listens
  on `:53` for the delegated `acme.sophtwhere.com` zone).
- **pm2** (resurrected on boot via `pm2-jonathan.service`) runs two apps:
  `pptx-dev-server` (`npm run open-in-browser`) and `pptx-watch`
  (`npm run watch-web`).
- The Koa proxy patch (`scripts/fix-koa-proxy.cjs`) is what makes test-web
  emit `https://` URLs when behind Caddy. Without it, the browser would
  show a wall of mixed-content errors.

Five DNS records on BinaryLane make it work; never edit them by hand
without checking the infrastructure doc first.

## Open / not-done things

- **Visual verification of the Pptx Info webview rendering real .pptx
  content** — see "Verification status" above. Highest-priority outstanding
  item.
- **Publishing path** (Marketplace vs Open VSX vs `.vsix` only) — unchanged
  from the previous handover; awaiting user decision.
- **`pptx-watch` rebuild after a `git pull`** — the user has verified
  esbuild's inotify watch picks up checkout writes in normal cases, but
  if you ever see "I pushed but the VPS still serves old code", the first
  thing to ask the user to check is `pm2 logs pptx-watch` for the rebuild
  line. If absent, `pm2 restart pptx-watch` is the fix.

## Dead ends — don't relitigate these

(Carried over verbatim from the previous handover; still apply.)

- **"Install Extension from Location..." in vscode.dev does NOT work for
  github.io URLs.** vscode.dev's CSP `connect-src` directive blocks any
  fetch to non-allowlisted origins. We don't need this any more — the
  user runs their own test-web instance over HTTPS.

- **Signing is not the issue.** vsce signing is for Marketplace, not for
  sideloading.

- **The Copilot diagnosis claiming CJS bundle was wrong and
  `activationEvents` needed entries was incorrect.** Web extensions DO
  use CJS. `activationEvents` are auto-inferred from
  `contributes.customEditors` since VS Code 1.74. Don't change either.

## Context files to read on the phone

- `README.md` — user-facing build/install/test docs (current)
- `pptx-viewer-agent-plan.md` — original bootstrap plan, history only
- `~/projects/CLAUDE.md` — user's wider preferences. Most still apply;
  the "plain Node, no frameworks unless they earn their keep, single-file
  until it doesn't, CSS help with explanation" guidance carries over.
- `~/.claude/projects/.../memory/MEMORY.md` — auto-memory index; user
  profile + GitHub auth notes still relevant.

## One thing the user values (unchanged)

They prefer Claude to do the coding so iterations stay documented and
reviewable. They are fluent in JavaScript but struggle with CSS — when
CSS comes up (likely if you end up tweaking `src/webview.ts`), be generous
with styling help and **explain the rules being applied** so the lesson
sticks.
