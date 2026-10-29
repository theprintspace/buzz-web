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
