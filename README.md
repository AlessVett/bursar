# Bursar

Bursar is a self-hosted personal finance assistant. It reads your bank accounts through the Enable Banking API (read-only), keeps an encrypted archive of your financial documents, and runs a team of Claude agents that write a daily report on how your money is managed.

> **Status:** early development. Nothing here is ready for real use yet.

## Where your data goes

Bursar stores everything on your own server, encrypted at rest. Processing still involves third parties:

- Anthropic receives everything the agents read.
- Enable Banking brokers bank data: balances and transactions of the accounts you connect, read-only.
- Your SMTP provider relays the notification emails, if you configure email. They carry an event title and a link to the panel, never financial data.
- The backup target, if you configure one (Cloudflare R2 in the reference deployment), holds only encrypted copies of the database. Without the master key they cannot be read.
- Cloudflare terminates TLS if you use a Cloudflare Tunnel.
- Your hosting provider holds the disk, together with the master key that decrypts it. Encryption at rest protects copies of the data volume and backups that leave the host without the key; it does not protect against whoever controls the host.

## Bank accounts

Bursar reads balances and transactions through Enable Banking and never moves money: the server can reach only a fixed list of account-information operations, and every payment operation is rejected before a request leaves the process. Free usage is Enable Banking's restricted mode: a production application that you activate by linking your own accounts in the Enable Banking Control Panel. Only linked accounts return data, so link every account first. Bank consents last up to 180 days for most banks and are renewed from the Accounts page. Setup, the redirect URL, limits and troubleshooting: [docs/enable-banking.md](docs/enable-banking.md).

## Backups

Every night Bursar writes an encrypted copy of its database to the data volume and, if you configure a bucket, uploads it to an S3-compatible target such as Cloudflare R2. It keeps 7 daily, 4 weekly and 6 monthly copies. The master key is never part of a backup: keep an offline copy of it. Setup, the command-line tools, restoring and the restore test: [docs/backup-restore.md](docs/backup-restore.md). Deployment of the whole stack: [docs/deployment.md](docs/deployment.md).

## Development

Requirements: Node 24, pnpm (via `packageManager`), Docker, gitleaks.

    pnpm install
    pnpm test

The panel has a visual quality check that starts a throwaway server with fictional data and walks through every page in light and dark mode and at phone width, writing screenshots and failing on console errors, layout overflow or untranslated text. It uses the Chrome installed on your machine:

    pnpm --filter @bursar/web qa

## License

MIT — see [LICENSE](LICENSE).
