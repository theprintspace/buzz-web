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

## Fork change: pair the Buzz phone app from the browser (30 Oct 2026)

The Buzz phone apps (iOS `id6779728271`, Android `xyz.block.buzz.mobile`) only sign in by
scanning a pairing QR code, which upstream only the desktop app can show. People who use
Buzz in the browser (Intel Macs) had no way to get their identity onto a phone; scanning
nothing and continuing created a second, empty identity on the phone.

Settings → **Mobile app** now runs the source side of Block's NIP-AB device pairing
(`crates/buzz-core/src/pairing/NIP-AB.md` in block/buzz) in the browser:

- `src/features/pairing/lib/nip-ab.ts`: the primitives, checked against the spec's test
  vectors (HKDF session id, unhashed ECDH x-coordinate, SAS, transcript hash), the
  `nostrpair://` URI (encoded exactly like the Rust reference, dots included), NIP-44 v2
  event building and validation. No `@/` imports so the Playwright suite can play the phone.
- `src/features/pairing/lib/pairing-source-session.ts`: the pure state machine. It
  supports Buzz's `desktop-code-v1` extension, which the phone app always asks for: the
  browser shows a random six-digit code, the phone user types it, five wrong guesses end the
  session; a phone that does not ask for it gets the spec's compare-the-codes flow instead.
  The payload is the same JSON the desktop sends (`{relayUrl, pubkey, nsec}` as a
  `custom` payload, `relayUrl` being the relay's https origin), produced only at the
  moment of release.
- `src/features/pairing/use-phone-pairing.ts`: the socket to the pairing relay (AUTH
  challenge answered with the ephemeral key, QR shown only once the subscription's EOSE
  arrives, 120 s session, 30 s wait for `complete`, abort on cancel or unmount).
- `src/features/pairing/ui/PhonePairingSection.tsx`: the section (store links, QR, code,
  three steps). Extension-held identities cannot be exported, and the section says so.
- `nostr-signer.ts` gained `exportActiveIdentity()` (local identities only).
- `config.json` gained `pairingRelayUrl` (`wss://pairing.buzz.xyz`, Block's open, stateless
  pairing relay, which accepts browser origins). Without it the client reads
  `pairing_relay_url` from the relay's NIP-11 document and otherwise falls back to the same
  default. Our relay's NIP-11 advertises NIP-43, which makes the desktop app try
  `wss://buzz-relay.creativehub.io/pair`; that endpoint does not exist on the Railway relay
  (no `buzz-pair-relay` sidecar), so the relay's `BUZZ_PAIRING_RELAY_URL` must point at a
  pairing relay for desktop-to-phone pairing to work too.

Tests: `nip-ab.test.ts` (spec vectors), `pairing-source-session.test.ts` (both flows, wrong
codes, impostors, duplicates, expiry, aborts) and the smoke test "Settings pair the phone
app…", which creates a local identity through an invite, then plays the phone over a
routed WebSocket: offer, wrong code, right code, decrypts the identity and confirms.
