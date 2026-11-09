# 0003 — Publishing images that bundle the Agent SDK (gate V3)

- **Date:** 2026-11-09
- **Status:** accepted
- **Supersedes:** the published-image deployment in the design spec: §4 D8 (pull-based deploy with Watchtower), the §5 architecture diagram (watchtower service), the §8 supply-chain row (Watchtower following `stable`), §10 (watchtower profile), §11 (`release.yml` pushing to GHCR, Watchtower deploy) and §14 M6 (published release). The spec now describes source-based deployment.

## Question

May a public container image include `@anthropic-ai/claude-agent-sdk` and its bundled Claude Code binary? (Spec §15, V3.)

## Evidence

Package `license` field: `SEE LICENSE IN README.md`. The installed `README.md` (version 0.3.319) contains no licence sentence. The licence text is in the package's `LICENSE.md`. The platform package `@anthropic-ai/claude-agent-sdk-darwin-arm64` (the only platform package installed on the machine where this was checked; `-linux-x64` was not installed) declares `SEE LICENSE IN LICENSE.md` and ships a `LICENSE.md` with the same text:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

The only terms-related passage in the README points at the Commercial Terms, in the data section:

> For full details, please review our [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) and [Privacy Policy](https://www.anthropic.com/legal/privacy).

Agent SDK overview (https://code.claude.com/docs/en/agent-sdk/overview), section "License and terms":

> Use of the Claude Agent SDK is governed by [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), including when you use it to power products and services that you make available to your own customers and end users, except to the extent a specific component or dependency is covered by a different license as indicated in that component's LICENSE file.

Legal and compliance page (https://code.claude.com/docs/en/legal-and-compliance), section "Can customers offer Claude Code in their products?":

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) and complying with the conditions below:

> **The Claude Code binary must not be modified.** Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).

Anthropic Commercial Terms (https://www.anthropic.com/legal/commercial-terms, effective Jun 17, 2025), Section A.1:

> Anthropic gives Customer permission to use the Services, including to power products and services Customer makes available

Section D.4 (Use Restrictions):

> Customer may not and must not attempt to (a) access the Services to build a competing product or service,

> including to train competing AI models or resell the Services except as expressly approved by Anthropic;

Section F (Intellectual Property):

> Except as expressly stated in these Terms, these Terms do not grant either party any rights to the other’s content

> or intellectual property, by implication or otherwise.

None of the fetched documents contains a sentence granting a right to redistribute the SDK or the Claude Code binary as part of a publicly published container image. The permissions found concern using the SDK to power products that the customer operates.

## Decision

Rule applied: publish images only if the terms explicitly allow redistribution of the SDK in a container image.

Outcome: Not explicitly allowed: no public images; operators build from source with `docker compose build`, and the release workflow only builds and tests.
