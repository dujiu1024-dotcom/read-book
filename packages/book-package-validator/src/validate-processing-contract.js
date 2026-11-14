import { readFile } from "node:fs/promises";
import { validateProcessingContract } from "./validator.js";
const contract = JSON.parse(await readFile(new URL("../processing-contract.json", import.meta.url), "utf8"));
const issues = validateProcessingContract(contract);
process.stdout.write(JSON.stringify({ status: issues.length ? "invalid" : "valid", issues }, null, 2) + "\n");
process.exitCode = issues.length ? 1 : 0;
