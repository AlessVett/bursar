# Deployment (reference: Docker host + Cloudflare Tunnel, optional Access)

This guide uses placeholders: `<host>` (ssh alias), `<dir>` (absolute deploy directory, for example `/opt/bursar`), `<hostname>` (public hostname of the panel).

Images are never pulled from a registry: they are built from source on the host (see `docs/decisions/0003-sdk-redistribution.md`).

## 1. Cloudflare

1. The hostname's zone must be on Cloudflare.
2. Zero Trust, Networks, Tunnels: create a Cloudflared tunnel named `bursar`. Copy its token.
3. In the tunnel, add a public hostname `<hostname>` with service `http://app:8080`.
4. Optional but recommended (defence in depth on top of the app login): Zero Trust, Access, Applications: add a self-hosted application for `<hostname>` with an Allow policy for your email. Copy the **Application Audience (AUD) tag** and note your team domain (`<team>.cloudflareaccess.com`).

Cloudflare Access is optional. Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` together or leave both empty. Without Access on a non-loopback URL the app logs a warning at startup.

## 2. Host preparation

The app runs as uid 1000 inside the container, so every secret file must be owned by uid 1000 with mode 600 (under rootless Docker, Podman or userns-remap, use the mapped uid instead).

    ssh <host> 'install -d -m 755 <dir> <dir>/releases && install -d -m 700 -o 1000 -g 1000 <dir>/secrets'
    ssh <host> 'umask 077; head -c 32 /dev/urandom | base64 > <dir>/secrets/master_key; chown 1000:1000 <dir>/secrets/master_key; chmod 600 <dir>/secrets/master_key'

Keep an offline copy of `<dir>/secrets/master_key` (for example in a password manager): without it the data cannot be decrypted.

Create `<dir>/.env` (mode 600) from `deploy/env.example` with:

- `BURSAR_PUBLIC_URL=https://<hostname>`
- `TZ` (your time zone)
- `BURSAR_SECRETS_DIR=<dir>/secrets`
- `BURSAR_TRUST_CF_CONNECTING_IP=true`: required in tunnel deployments, where every request reaches the app from cloudflared and the client address comes from the `CF-Connecting-IP` header. Leave it `false` whenever the app is reachable without Cloudflare, because clients could forge the header.
- `TUNNEL_TOKEN`
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`, only if you enabled Access (both or neither)

Optional Claude credential for the agent runtime: write it to `<dir>/secrets/claude_credential` (owner 1000, mode 600) and set `BURSAR_CLAUDE_CREDENTIAL_ENV` in `.env` to `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. When the file exists, the deploy adds `deploy/compose.claude.yaml` automatically.

Check ownership and modes without printing contents:

    ssh <host> 'ls -la <dir> <dir>/secrets'

Expected: `.env` is `-rw-------`; `secrets/` is `drwx------` owned by `1000`; each secret file is `-rw-------` owned by `1000`.

## 3. Deploy

Put `BURSAR_DEPLOY_HOST` and `BURSAR_DEPLOY_DIR` in `.env.deploy` at the repository root (gitignored), or export them, then:

    deploy/deploy.sh [git-ref]

The script uploads the chosen commit (default `HEAD`) as `<dir>/releases/<UTC timestamp>-<short sha>/`, builds the image on the host, starts the stack with the `tunnel` profile, waits until the app is healthy and then points `<dir>/current` at the release. Old releases stay under `<dir>/releases/`; remove them manually when no longer needed.

## 4. Verify

    curl -s -o /dev/null -w '%{http_code}\n' https://<hostname>/healthz
    ssh <host> 'docker exec bursar-app-1 node -e "fetch(\"http://127.0.0.1:8080/healthz\").then(r=>console.log(r.status))"'

With Access enabled, the public request returns `302` or `403` from Cloudflare (unauthenticated requests are blocked at the edge); without Access it reaches the app. The internal health check returns `200`.

## 5. First run

1. Open `https://<hostname>` and pass the Access login, if enabled.
2. Read the setup code on the host: `ssh <host> 'docker exec bursar-app-1 cat /data/setup-code'`.
3. Enter it with a new password, then enrol the authenticator app.
