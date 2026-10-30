# theprintspace deployment notes

This fork of [hardy4yooz/buzz-web](https://github.com/hardy4yooz/buzz-web) is the browser client for the
company's own Buzz relay. Two files differ from upstream:

- `web/public/config.json` (and `deploy/config.json`): `relayUrl` points at `wss://buzz-relay.creativehub.io`,
  the relay in the Railway project `tps-buzz` (workspace TPS Projects), community name `creativehub`.
- `web/Caddyfile`: `/` redirects to `/app/`, so https://buzz.creativehub.io opens the client directly.

The Railway service `buzz-web` in `tps-buzz` builds `web/Dockerfile` (root directory `web`) and serves on
port 8080 with the health check `/app/healthz`. Keep upstream changes flowing by merging `hardy4yooz/buzz-web`
`main` into this `main`; `config.json` and the Caddyfile redirect are the only local changes to re-check.

Nothing secret lives in this repo: `config.json` is public runtime configuration by design.

## Fork change: invites join in the browser without an extension (30 Oct 2026)

Upstream's `/invite/<code>` page only shows "Join in browser" when a NIP-07 signing
extension is installed; otherwise it hands off to the desktop app, which does nothing on a
machine without it. Our old Intel Macs are exactly that case, so the page now always offers
"Join in browser": with no extension and no unlocked identity it shows the app's identity
gate (create, import, restore or unlock an identity on this device), then claims the invite
with that identity (`claimInviteInBrowser(..., "local")`, which insists on the active signer
and never a throwaway key) and navigates into the app signed in. Files:
`web/src/features/invite/ui/InvitePage.tsx`, `InviteIdentityClaim.tsx`,
`web/src/features/invite/invite-api.ts`, `web/src/shared/lib/nip98.ts`, tests in
`web/src/features/invite/invite-api.test.ts`. When merging upstream, keep this behaviour.
