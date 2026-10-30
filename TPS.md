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

## Fork change: browser notifications, tab title and badge (30 Oct 2026)

Upstream has no notifications at all (the service worker only caches). The fork adds, for people
who live in the browser client:

- A **Notifications** section in Settings. "Turn on notifications" asks the browser for permission
  (always from a click, never on load); once granted a switch turns them on or off per browser
  (`localStorage` key `buzz-web:browser-notifications`). A blocked permission shows how to allow it
  again; an unsupported browser says so.
- A one-time prompt (toast with "Turn on") the first time the inbox has loaded and the permission
  is still undecided (`buzz-web:browser-notifications:prompted`).
- A system notification for each new unread inbox item (mention, direct message, thread reply,
  action request) that arrives **while the tab is in the background or unfocused**, from someone
  else, at most 10 minutes old; more than three in one update collapse into "N new messages in
  Buzz". Clicking one focuses the tab and opens the conversation. Open notifications close when
  the tab comes back. Nothing fires for what was already there when the page loaded.
- The unread inbox count in the tab title, "(3) Buzz Web", and on the installed app's icon badge
  where the browser supports `navigator.setAppBadge`.

Notifications only arrive while a Buzz tab is open: there is no web push when the tab is closed.
Files: `web/src/features/inbox/lib/browser-notifications.ts` (pure helpers, tested in
`browser-notifications.test.ts`), `web/src/features/inbox/use-browser-notifications.ts` (the hook),
the Notifications section in `web/src/features/chat/ui/SettingsDialog.tsx`, wiring in
`BuzzWebApp.tsx`, strings `notifications.*` and `settings.notifications`; the browser test stubs
`Notification` because headless Chromium reports the permission as denied. When merging upstream,
keep this behaviour.
