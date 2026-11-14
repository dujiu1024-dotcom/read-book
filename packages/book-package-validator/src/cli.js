#!/usr/bin/env node
import { validatePackage } from "./validator.js";
const input = process.argv[2];
if (!input) {
  process.stderr.write("Usage: read-book-package-validate <package-directory-or-zip>\n");
  process.exitCode = 2;
} else {
  const result = await validatePackage(input);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.status === "valid" ? 0 : 1;
}
