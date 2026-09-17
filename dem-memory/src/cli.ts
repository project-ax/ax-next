import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { createDemMemory, type DemMemory } from "./index.js";
import { memoryStatement } from "./types.js";

interface CliArgs {
  db: string;
  bank: string;
  embed: "vertex" | "hash";
  reranker: "cohere" | "lexical" | "none";
}

function parseArgs(argv: string[]): { flags: CliArgs; positional: string[] } {
  const flags: CliArgs = {
    db: process.env.DEM_DB_PATH ?? "./dem-memory.db",
    bank: process.env.DEM_BANK_ID ?? "default",
    embed: (process.env.DEM_EMBED_PROVIDER as CliArgs["embed"]) ?? "vertex",
    reranker: (process.env.DEM_RERANKER as CliArgs["reranker"]) ?? "cohere",
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--db") flags.db = argv[(i += 1)] ?? flags.db;
    else if (arg === "--bank") flags.bank = argv[(i += 1)] ?? flags.bank;
    else if (arg === "--embed") flags.embed = (argv[(i += 1)] as CliArgs["embed"]) ?? flags.embed;
    else if (arg === "--reranker")
      flags.reranker = (argv[(i += 1)] as CliArgs["reranker"]) ?? flags.reranker;
    else positional.push(arg);
  }
  return { flags, positional };
}

async function printRecallAsync(memory: DemMemory, query: string, asOf?: string): Promise<void> {
  const result = await memory.recall(query, { asOf: asOf ?? new Date().toISOString() });
  console.log(`channels: sparse=${result.channels.sparse.length} dense=${result.channels.dense.length} graph=${result.channels.graph.length} temporal=${result.channels.temporal.length} reranked=${result.reranked}`);
  if (result.tuples.length === 0) {
    console.log("(no memories recalled)");
    return;
  }
  for (const tuple of result.tuples) {
    console.log(
      `  [${tuple.network}] ${tuple.validStart.slice(0, 10)} -> ${tuple.validEnd === "9999-12-31T23:59:59.999Z" ? "∞" : tuple.validEnd.slice(0, 10)} ${memoryStatement(tuple.subject, tuple.predicate, tuple.object)}`,
    );
  }
}

// An interactive question is asked *now*, so "now" is what grounds "how long ago did I...".
// The library itself stays explicit: only this entrypoint reads the wall clock.
async function printAsk(memory: DemMemory, question: string, asOf?: string): Promise<void> {
  const result = await memory.reflect(question, { asOf: asOf ?? new Date().toISOString() });
  console.log(`evidence rows: ${result.evidence.length} (tokens ~${result.tokens})`);
  console.log(`answer: ${result.answer}`);
}

async function runCommand(memory: DemMemory, command: string, rest: string[]): Promise<boolean> {
  const joined = rest.join(" ").trim();
  switch (command) {
    case "retain": {
      const input = joined === "-" ? readFileSync(0, "utf8") : joined;
      const result = await memory.retain(input);
      console.log(`retained ${result.tuples.length} fact(s), invalidated ${result.invalidatedCount}`);
      for (const tuple of result.tuples) {
        console.log(`  [${tuple.network}] ${memoryStatement(tuple.subject, tuple.predicate, tuple.object)}`);
      }
      return true;
    }
    case "recall":
      await printRecallAsync(memory, joined);
      return true;
    case "ask":
      await printAsk(memory, joined);
      return true;
    default:
      return false;
  }
}

const HELP = [
  "Commands:",
  "  /retain <dialogue text>   extract and store facts from dialogue",
  "  /recall <query>           run the four-channel retrieval pipeline",
  "  /ask <question>           recall + single-pass grounded synthesis",
  "  /bank <id>                switch memory bank",
  "  /stats                    show bank statistics",
  "  /help                     show this help",
  "  /quit                     exit",
].join("\n");

async function repl(memory: DemMemory): Promise<void> {
  console.log(`dem-memory cli — bank "${memory.bankId}" — type /help for commands`);
  const rl = createInterface({ input: stdin, output: stdout });
  for (;;) {
    const line = (await rl.question("dem> ")).trim();
    if (line.length === 0) continue;
    if (line === "/quit" || line === "/exit") break;
    if (line === "/help") {
      console.log(HELP);
      continue;
    }
    if (line === "/stats") {
      console.log(memory.stats());
      continue;
    }
    if (line.startsWith("/bank ")) {
      const bank = line.slice("/bank ".length).trim();
      memory.setBank(bank);
      console.log(`switched to bank "${bank}"`);
      continue;
    }
    if (line.startsWith("/retain ")) {
      await runCommand(memory, "retain", [line.slice("/retain ".length)]);
      continue;
    }
    if (line.startsWith("/recall ")) {
      await runCommand(memory, "recall", [line.slice("/recall ".length)]);
      continue;
    }
    if (line.startsWith("/ask ")) {
      await runCommand(memory, "ask", [line.slice("/ask ".length)]);
      continue;
    }
    console.log(`unknown command: ${line} — ${HELP}`);
  }
  rl.close();
  memory.close();
}

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const memory = createDemMemory({
    path: flags.db,
    bankId: flags.bank,
    embedProvider: flags.embed,
    rerank: flags.reranker,
  });

  if (positional.length === 0) {
    await repl(memory);
    return;
  }

  const [command, ...rest] = positional;
  const handled = command !== undefined && (await runCommand(memory, command, rest));
  if (!handled) {
    console.error(`unknown command "${command ?? ""}" — expected ask, recall, or retain`);
    memory.close();
    process.exitCode = 1;
    return;
  }
  memory.close();
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
