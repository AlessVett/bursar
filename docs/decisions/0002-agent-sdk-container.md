# 0002 — Agent SDK isolation in the container (gate V2)

- **Date:** 2026-11-09
- **Status:** accepted for local Docker; host confirmation pending

## Question

Does the Agent SDK run inside the read-only container with a credential from a `*_FILE` secret, and do `persistSession: false` plus a temporary `CLAUDE_CONFIG_DIR` keep transcripts off the disk? (Spec §15, V2.)

## Evidence

Command: `docker compose … run --rm --no-deps app node dist/sdk-gate.js`

```json
{
  "ok": true,
  "answeredOk": true,
  "costUsd": 0.0001659,
  "filesWritten": [
    "claude-config-3S9wPM/.claude.json",
    "claude-config-3S9wPM/policy-limits.json",
    "claude-config-3S9wPM/policy-limits.json.signature.json",
    "claude-config-3S9wPM/policy-limits.json.stamp.json",
    "claude-config-3S9wPM/remote-settings.json",
    "claude-config-3S9wPM/remote-settings.json.synced-at",
    "claude-config-3S9wPM/backups/.claude.json.backup.1794223764168",
    "claude-config-3S9wPM/plugins/store/cc-plugin-agents-md_builtin-b049b47b3618.json"
  ],
  "transcripts": []
}
exit=0
```

The run used Docker Desktop on a development machine. The temporary `CLAUDE_CONFIG_DIR` received settings and policy files (listed in `filesWritten`) but no transcripts (`*.jsonl`). The temporary working directory received nothing. Both directories were created under `/tmp`, which is a tmpfs inside the read-only container, so nothing was written to a persistent disk.

## Decision

Agent runs use: `tools: []`, `settingSources: []`, `strictMcpConfig: true`, `persistSession: false`, `CLAUDE_CONFIG_DIR` and `HOME` in per-run temporary directories under the tmpfs, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`. Files listed under `filesWritten` live only on tmpfs.
