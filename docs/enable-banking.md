# Enable Banking setup

Bursar reads balances and transactions of your bank accounts through [Enable Banking](https://enablebanking.com), a licensed account-information provider. Access is read-only: the server can call a fixed list of account-information operations (banks, authorisation, sessions, balances, transactions), and every payment operation is rejected before a request leaves the process.

This guide uses placeholders: `<host>` (ssh alias of the Docker host), `<dir>` (deploy directory on the host), `<hostname>` (public hostname of the panel). Secrets are never written in documents or commands: the private key lives in a file on the host.

## 1. Sandbox or production

An Enable Banking application belongs to one environment, and it cannot be moved to the other. Both environments use the same API address; the environment is a property of the application (its id), not of the URL.

| | Sandbox | Production (restricted mode) |
|---|---|---|
| Banks | Test banks such as "Mock ASPSP", with test users | Your real banks |
| Activation | Automatic | By linking your own accounts in the Control Panel (see section 5) |
| Data | Fake transactions, returned in batches of 10, newest first | Your real accounts, only the linked ones |
| Caveats | Sessions can expire before the requested date, date filters are unreliable, some test banks are unstable | Real banks, real strong customer authentication |

Use a Sandbox application to try Bursar and to test the renewal of a consent before connecting a real bank. Use a production application, in restricted mode, for your own accounts.

## 2. Create the key and the certificate

Enable Banking authenticates every request with a signed token (RS256). You keep an RSA private key; you upload only the matching certificate. The private key never leaves your server and is never committed, logged or shown by Bursar.

On the Docker host, create the key straight into the secrets directory (readable by uid 1000, mode 600) and the certificate next to it:

    ssh <host> 'test ! -e <dir>/secrets/eb_private_key && (umask 077; openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 3650 -subj "/CN=bursar" -keyout <dir>/secrets/eb_private_key -out <dir>/eb_certificate.pem) && chown 1000:1000 <dir>/secrets/eb_private_key && chmod 600 <dir>/secrets/eb_private_key'

The `test ! -e` guard refuses to replace an existing key. Check that the key parses without printing it, and copy the public certificate to your workstation to upload it:

    ssh <host> 'openssl pkey -in <dir>/secrets/eb_private_key -noout && echo key-ok'
    scp <host>:<dir>/eb_certificate.pem .

The certificate is public and can be deleted from the host after the upload. Keep an offline copy of the private key next to the offline copy of the master key: without it you create a new key and a new certificate, and upload the certificate again.

For local development with a Sandbox application, create the key outside the repository, for example in a private directory of your home, with the same `openssl req` command and `umask 077`, and point `EB_PRIVATE_KEY_FILE` at it in `apps/server/.env`. The repository's `.gitignore` also excludes `*.pem` and `*.key`, but a key never belongs inside the working tree.

The Control Panel can also generate the key in your browser and offer it for download once. That works, but the key then passes through your workstation; if you use it, move the file to the host, set the owner and mode as above, and delete the download.

## 3. Register the application

1. Open the Enable Banking Control Panel (https://enablebanking.com/cp/applications) and add an application.
2. Choose the environment: Sandbox or Production.
3. Name it, upload `eb_certificate.pem`, and fill the other fields the form asks for. In restricted mode Enable Banking does not verify the terms, privacy and data protection fields.
4. Add the redirect URL (see below).
5. Copy the **application id** (a uuid) that the Control Panel shows.

### Redirect URL

Enable Banking sends the browser back to a redirect URL that you whitelist per application. Bursar always uses `<BURSAR_PUBLIC_URL>/api/banks/callback`:

- Production and a deployed Sandbox: `https://<hostname>/api/banks/callback`
- Local development against the Sandbox (the panel dev server on port 5173 proxies `/api` to the server, and `BURSAR_PUBLIC_URL` is `http://localhost:5173` in `apps/server/.env.example`): `http://localhost:5173/api/banks/callback`

The URL must match exactly: scheme, host, port and path, without a trailing slash. If Enable Banking refuses an `http://localhost` redirect URL for a Sandbox application, run the Sandbox application on a deployed host instead, with the `https://<hostname>` URL. A mismatch is reported as `REDIRECT_URI_NOT_ALLOWED` (see the troubleshooting section). The panel shows whether the URL is accepted under Settings, Banking ("Redirect URL allowed").

## 4. Configure Bursar

On a host, set the application id in `<dir>/.env` and make sure the key file exists at `<dir>/secrets/eb_private_key`:

    EB_APPLICATION_ID=<application id>
    BURSAR_TRUST_CF_CONNECTING_IP=true

The deploy adds `deploy/compose.banking.yaml` automatically when `eb_private_key` exists in the secrets directory, and passes the key to the app as `EB_PRIVATE_KEY_FILE`. Set the application id and place the key in the same deploy: with only one of them the app refuses to start and names the missing variable in `docker logs bursar-app-1`.

`BURSAR_TRUST_CF_CONNECTING_IP=true` is required behind a Cloudflare Tunnel. Every request then reaches the app from cloudflared, and the address of the person using the panel comes from the `CF-Connecting-IP` header. Without it, "Sync now" sees a private address and syncs as a background job (see section 7). Leave it `false` when the app is reachable without Cloudflare, because clients could forge the header.

For local development, put `EB_APPLICATION_ID` and `EB_PRIVATE_KEY_FILE` (the path of the key) in `apps/server/.env`.

After the deploy, open Settings, Banking in the panel: it shows the environment, whether the application is active and whether the redirect URL is allowed. `docker exec bursar-app-1 node dist/cli.js banking status` lists the connections and accounts later on (masked identifiers only).

## 5. Restricted mode: link your accounts first

A production application starts as pending. Without a contract, Enable Banking activates it for personal use when you link (whitelist) your own bank accounts in the Control Panel (the "activate by linking accounts" option of the application; the labels may change). In restricted mode:

- The authorisation flow works for anyone, but only the linked accounts return data. Accounts that are not linked are stripped from the response.
- Link every account you want in Bursar before you authorise the bank. The identifier to link is the IBAN of the account (as the Control Panel asks for it).
- If you authorise a bank and none of the shared accounts is linked, the list of accounts comes back empty.

### What an empty account list means

Bursar treats an empty list as its own outcome, not as a success: the wizard shows "No accounts were shared" with the steps to link the missing accounts in the Control Panel, closes the session at the bank so no unused consent stays open, and creates no connection. Link the missing accounts in the Control Panel and connect the bank again.

## 6. Connect a bank, consent duration and renewal

1. In the panel, open Accounts and start the Connect wizard.
2. Pick the country and the bank. Bursar asks the bank list from Enable Banking for that country.
3. Authorise at the bank (strong customer authentication). The bank sends you back to Bursar, which shows the accounts it found and starts the first sync.

Complete the flow in a browser where you are signed in to the panel: the code exchange is an authenticated request, because session cookies are not sent on the cross-site redirect back from the bank. If the bank's app opens a different browser, sign in there and start again.

The first sync runs immediately. Many banks give the full transaction history only for a short time after authorisation (about an hour is typical) and limit later access to roughly the last 90 days, so connect when you have a few minutes and wait for the first sync to finish.

The **consent duration** is set in Settings, Banking (default 180 days). Each bank has a maximum (180 days for most); Bursar asks for the shorter of the two, minus a few minutes of margin. There is no refresh: when a consent ends you authorise again. Bursar warns by notification 14 days and 3 days before the end. A consent can also end early (see `EXPIRED_SESSION`).

To renew, use Renew on the connection in the Accounts page and authorise at the bank again. Accounts are matched to the existing ones through the identifier the bank provides (and the IBAN as a fallback), so names, history and settings stay attached. An account that the bank no longer returns becomes unavailable instead of disappearing.

## 7. Limits, background sync and "Sync now"

Banks limit how often a service can read an account while the customer is not present. Many allow 4 background fetches per account per day, and the figure can differ per bank. Bursar therefore:

- syncs once a day at the time set in Settings, Banking, and never more than the configured number of background syncs per account per day (default 2, from 1 to 4);
- after `ASPSP_RATE_LIMIT_EXCEEDED`, pauses that account for 6 hours;
- treats "Sync now" as a request from the person using the panel: it forwards your IP address and browser details to the bank as the user's, which banks count differently from background access. This only happens when the app sees a public client address, which behind Cloudflare Tunnel needs `BURSAR_TRUST_CF_CONNECTING_IP=true`; otherwise "Sync now" behaves like a background sync and counts against the limit.

Your address and browser details are sent to the bank with that request, which is a privacy consideration of its own. Avoid pressing "Sync now" repeatedly: the bank decides what it allows.

## 8. The Terms of restricted mode (gate V5)

Restricted mode is free. The project's research found that Enable Banking's Terms limit it to evaluation or personal use by private individuals; the Terms themselves are the authority. Before you connect real accounts (gate V5 of the project):

1. Read the Enable Banking Terms that apply to restricted mode in full.
2. Confirm that your use, which is read-only access to your own accounts for yourself, is within them.
3. Write down the date and the result (the reference deployment records it in `docs/decisions/0004-enable-banking-production.md`).

Do not link accounts of other people or of a company with this setup. If the Terms are unclear to you, stay on the Sandbox and ask Enable Banking before going further.

## 9. Troubleshooting by error code

Bursar logs and shows only the HTTP status, the error code and Enable Banking's message. Match on the code, not on the status: the same status can carry different codes.

### `REDIRECT_URI_NOT_ALLOWED`

Seen when starting a connection or a renewal. The redirect URL is not whitelisted for the application. Compare the URL shown under Settings, Banking with the list in the Control Panel; they must match exactly (scheme, host, port, path, no trailing slash). Fix `BURSAR_PUBLIC_URL` if the host is wrong, or add the URL in the Control Panel, then try again.

### `EXPIRED_SESSION`

Seen during a sync. The consent has ended, often before the date you asked for (Sandbox banks are known to expire sessions early, and a customer can revoke at the bank). The connection shows as expired and Bursar sends a notification. Renew the consent (section 6); history is kept.

### `ASPSP_RATE_LIMIT_EXCEEDED`

Seen during a sync, usually with HTTP 429. The bank refuses more reads while you are not present. Bursar pauses the account for 6 hours and tries again later by itself. If it recurs, lower the number of background syncs per account in Settings, Banking, and avoid repeated "Sync now".

### `PSU_HEADER_NOT_PROVIDED`

Seen during a manual sync, with HTTP 422. Some banks require the whole set of user headers, or none. Bursar retries the same sync once without the headers (as a background sync, counted against the limit) and the sync completes. If it appears for scheduled syncs, which never send those headers, report it as a bug. The related `PSU_HEADER_INVALID` means a header had an unusable value.

### Other messages you may meet

- `NO_ACCOUNTS_ADDED`: the application is in restricted mode and no allowed accounts are linked yet. Link them (section 5).
- `WRONG_ASPSP_PROVIDED`: the bank name or country does not match the bank list. Reload the Connect page and pick the bank again.
- `EXPIRED_AUTHORIZATION_CODE`, `WRONG_AUTHORIZATION_CODE`, `ALREADY_AUTHORIZED`: the code from the bank was used too late, is wrong, or was already used (for example after reloading the callback page). Start the connection again; nothing is created from a failed attempt.
- `AUTHORIZATION_NOT_PROVIDED`, `UNAUTHORIZED_ACCESS`, `ACCESS_DENIED`: the request was not accepted as coming from your application. Check that the key matches the uploaded certificate, that `EB_APPLICATION_ID` is the id of that application, and that the host clock is correct.
- The app does not start and `docker logs bursar-app-1` shows `Invalid configuration` with `EB_APPLICATION_ID` or the key: the id and the key file must be configured together, and the file must contain an RSA private key.
