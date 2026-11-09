# Bursar

Bursar is a self-hosted personal finance assistant. It reads your bank accounts through the Enable Banking API (read-only), keeps an encrypted archive of your financial documents, and runs a team of Claude agents that write a daily report on how your money is managed.

> **Status:** early development. Nothing here is ready for real use yet.

## Where your data goes

Bursar stores everything on your own server, encrypted at rest. Processing still involves third parties: Anthropic receives what the agents read, Enable Banking brokers bank data, and Cloudflare terminates TLS if you use a Cloudflare Tunnel.

## Development

Requirements: Node 24, pnpm (via `packageManager`), Docker, gitleaks.

    pnpm install
    pnpm test

## License

MIT
