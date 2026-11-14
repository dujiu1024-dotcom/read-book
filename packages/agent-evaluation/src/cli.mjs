#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { evaluateRecords } from "./metrics.mjs";

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error("Unexpected argument: " + key);
    result[key.slice(2)] = argv[++index];
  }
  return result;
}

try {
  const options = args(process.argv.slice(2));
  if (!options.input) throw new Error("Usage: node src/cli.mjs --input cases.jsonl [--output report.json] [--k 5]");
  const raw = await readFile(options.input, "utf8");
  const records = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error("Invalid JSONL at line " + (index + 1) + ": " + error.message); }
  });
  const pricing = options.inputPricePerMillion !== undefined || options.outputPricePerMillion !== undefined
    ? {
        input_per_million: Number(options.inputPricePerMillion || 0),
        output_per_million: Number(options.outputPricePerMillion || 0),
        currency: options.currency || "USD"
      }
    : null;
  const report = evaluateRecords(records, { k: options.k === undefined ? 5 : Number(options.k), pricing });
  const output = JSON.stringify(report, null, 2) + "\n";
  if (options.output) await writeFile(options.output, output, "utf8");
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + "\n");
  process.exitCode = 2;
}
