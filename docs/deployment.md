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

The commands below and `deploy/deploy.sh` expect to log in as root on the host: setting ownership to uid 1000 needs root, and the deploy reads the root-owned `.env`. With a sudo user instead, prefix the preparation commands with `sudo` and run the deploy as a user that can read `<dir>/.env`, write `<dir>/releases` and `<dir>/current`, and use Docker.

    ssh <host> 'install -d -m 755 <dir> <dir>/releases && install -d -m 700 -o 1000 -g 1000 <dir>/secrets'
    ssh <host> 'set -C; umask 077; head -c 32 /dev/urandom | base64 > <dir>/secrets/master_key && chown 1000:1000 <dir>/secrets/master_key && chmod 600 <dir>/secrets/master_key'

`set -C` makes the second command fail instead of replacing an existing key: a new key makes the existing data unreadable. Keep an offline copy of `<dir>/secrets/master_key` (for example in a password manager): without it the data cannot be decrypted.

Copy the template to `<dir>/.env` with mode 600, again without overwriting an existing file, then edit it on the host:

    ssh <host> 'set -C; umask 077; cat > <dir>/.env' < deploy/env.example

Set these values in `<dir>/.env`:

- `BURSAR_PUBLIC_URL=https://<hostname>`
- `TZ` (your time zone)
- `BURSAR_SECRETS_DIR=<dir>/secrets`
- `BURSAR_TRUST_CF_CONNECTING_IP=true`: required in tunnel deployments, where every request reaches the app from cloudflared and the client address comes from the `CF-Connecting-IP` header. Leave it `false` whenever the app is reachable without Cloudflare, because clients could forge the header.
- `TUNNEL_TOKEN`
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`, only if you enabled Access (both or neither)

Optional Claude credential for the agent runtime: write it to `<dir>/secrets/claude_credential` (owner 1000, mode 600) and set `BURSAR_CLAUDE_CREDENTIAL_ENV` in `.env` to `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. When the file exists, the deploy adds `deploy/compose.claude.yaml` automatically.

The other optional integrations (bank accounts, email, backups) are described in section 3.

Check ownership and modes without printing contents:

    ssh <host> 'ls -la <dir> <dir>/secrets'

Expected: `.env` is `-rw-------`; `secrets/` is `drwx------` owned by `1000`; each secret file is `-rw-------` owned by `1000`.

## 3. Optional integrations: secrets and overlays

Each integration has non-secret values in `<dir>/.env` and one secret file in `<dir>/secrets` (owner 1000, mode 600). The deploy includes an overlay file only when its secret file exists, so an integration you do not use needs nothing.

| Integration | Secret file | Overlay | Values in `.env` |
|---|---|---|---|
| Claude agents | `claude_credential` | `compose.claude.yaml` | `BURSAR_CLAUDE_CREDENTIAL_ENV` |
| Bank accounts (Enable Banking) | `eb_private_key` | `compose.banking.yaml` | `EB_APPLICATION_ID` |
| Email notifications (SMTP) | `smtp_password` | `compose.smtp.yaml` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_FROM` |
| Backups to an S3-compatible bucket | `backup_s3_secret_key` | `compose.backup.yaml` | `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`, `BACKUP_S3_ACCESS_KEY_ID` |

Set the `.env` values and place the secret file in the same deploy. An integration with only one half (the id without the key, the S3 endpoint without the secret key) makes the app stop at startup with a message that names the missing variables, never their values. The reverse also holds: if you delete a secret file, clear its values in `.env` before the next deploy, because the deploy then leaves the overlay out.

Secret values are never typed on a command line. To write one without leaving it in the shell history, let the remote shell read it from the terminal (paste, Enter, Ctrl-D); `set -C` makes the command fail instead of replacing an existing file:

    ssh <host> 'set -C; umask 077; cat > <dir>/secrets/<secret file> && chown 1000:1000 <dir>/secrets/<secret file> && chmod 600 <dir>/secrets/<secret file>'

### 3.1 Bank accounts (Enable Banking)

Follow `docs/enable-banking.md`: it creates the RSA key directly in `<dir>/secrets/eb_private_key` on the host (so you do not use the command above for this one), registers the application and its redirect URL `https://<hostname>/api/banks/callback`, and explains restricted mode. Then set in `<dir>/.env`:

- `EB_APPLICATION_ID`: the application id (a uuid) from the Enable Banking Control Panel.
- `BURSAR_TRUST_CF_CONNECTING_IP=true`, as in section 2: without it "Sync now" cannot forward your address to the bank and counts as a background sync.

### 3.2 Email notifications (SMTP)

Notification emails contain an event title and a link to the panel, never financial data. In `<dir>/.env`:

- `SMTP_HOST`: the mail server.
- `SMTP_PORT`: `587` (the default) for `starttls`, `465` for `tls`.
- `SMTP_SECURITY`: `starttls` (default), `tls` (implicit TLS) or `none` (accepted only for a loopback host).
- `SMTP_USER`: the login name; leave empty, and place no password file, for a relay that needs no login.
- `SMTP_FROM`: the sender address.

Write the password to `<dir>/secrets/smtp_password` with the command above. Check it in the panel with Settings, Notifications, "Send test email".

### 3.3 Backups

Backups to the data volume (`/data/backups`) need nothing. To upload them to Cloudflare R2 or another S3-compatible bucket, follow `docs/backup-restore.md`: create a private bucket and a token scoped to it, put the `BACKUP_S3_*` values in `<dir>/.env` and the secret access key in `<dir>/secrets/backup_s3_secret_key`. Keep an offline copy of `<dir>/secrets/master_key`: a backup is useless without it.

Container logs rotate on their own (10 MB per file, 3 files per container).

## 4. Deploy

Put `BURSAR_DEPLOY_HOST` and `BURSAR_DEPLOY_DIR` in `.env.deploy` at the repository root (gitignored), or export them, then:

    deploy/deploy.sh [git-ref]

The script uploads the chosen commit (default `HEAD`) as `<dir>/releases/<UTC timestamp>-<short sha>/`, builds the image on the host, starts the stack with the `tunnel` profile, waits until the app is healthy and then points `<dir>/current` at the release. Old releases stay under `<dir>/releases/`; remove them manually when no longer needed.

## 5. Verify

    curl -s -o /dev/null -w '%{http_code}\n' https://<hostname>/healthz
    ssh <host> 'docker exec bursar-app-1 node -e "fetch(\"http://127.0.0.1:8080/healthz\").then(r=>console.log(r.status))"'

With Access enabled, the public request returns `302` or `403` from Cloudflare (unauthenticated requests are blocked at the edge); without Access it reaches the app. The internal health check returns `200`.

Check the startup log for configuration problems (there should be no `Invalid configuration` message):

    ssh <host> 'docker logs --since 5m bursar-app-1'

After you have connected a bank, list the connections and accounts (masked identifiers and counts only, no names or amounts):

    ssh <host> 'docker exec bursar-app-1 node dist/cli.js banking status'

With a backup target configured, make a backup and expect a JSON line with `setId`, `sizeBytes` and `"target":"s3"` (`"local"` without a bucket), then run the restore test of `docs/backup-restore.md`:

    ssh <host> 'docker exec bursar-app-1 node dist/cli.js backup run'

## 6. First run

1. Open `https://<hostname>` and pass the Access login, if enabled.
2. Read the setup code on the host: `ssh <host> 'docker exec bursar-app-1 cat /data/setup-code'`.
3. Enter it with a new password, then enrol the authenticator app.

## 7. Connect your banks

Once you are signed in, open Accounts in the panel and connect a bank (see `docs/enable-banking.md`, sections 5 to 7: link your accounts first, then authorise). The first sync runs as soon as you return from the bank.
