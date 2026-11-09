import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeCredential } from "../config";

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function main(): Promise<number> {
  const credential = loadClaudeCredential(process.env);
  if (!credential) {
    console.error("No Claude credential configured (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)");
    return 2;
  }
  const configDir = mkdtempSync(path.join(tmpdir(), "claude-config-"));
  const workDir = mkdtempSync(path.join(tmpdir(), "claude-work-"));

  let ok = false;
  let answer = "";
  let costUsd: number | undefined;
  for await (const message of query({
    prompt: "Reply with exactly the word OK and nothing else.",
    options: {
      tools: [],
      allowedTools: [],
      mcpServers: {},
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      model: "haiku",
      maxTurns: 1,
      cwd: workDir,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: workDir,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
        [credential.envName]: credential.value,
      },
    },
  })) {
    if (message.type === "result") {
      ok = message.subtype === "success";
      if (message.subtype === "success") answer = message.result;
      costUsd = message.total_cost_usd;
    }
  }

  const written = [...listFiles(configDir), ...listFiles(workDir)];
  const transcripts = written.filter((file) => file.endsWith(".jsonl"));
  const answeredOk = answer.trim() === "OK";
  console.log(
    JSON.stringify(
      {
        ok,
        answeredOk,
        costUsd,
        filesWritten: written.map((file) => path.relative(tmpdir(), file)),
        transcripts: transcripts.map((file) => path.relative(tmpdir(), file)),
      },
      null,
      2,
    ),
  );
  return ok && answeredOk && transcripts.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
