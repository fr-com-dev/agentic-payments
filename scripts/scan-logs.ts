// `... | npm run scan-logs`: reads log lines on stdin and fails on any credential shape (specs/011
// contracts/deploy-pipeline.md step 9). Prints only the pattern names and line numbers, never the text.
// Exit codes: 0 clean; 1 a credential shape was found.
import { findSecretShapes } from "./secret-scan-lib.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const lines = Buffer.concat(chunks).toString("utf8").split("\n");
let hits = 0;
for (const [i, line] of lines.entries()) {
  const found = findSecretShapes(line);
  if (found.length > 0) {
    hits++;
    console.error(`scan-logs: line ${i + 1}: ${found.join(", ")}`);
  }
}
console.log(hits === 0 ? `scan-logs: clean (${lines.length} lines)` : `scan-logs: ${hits} line(s) with credential shapes`);
process.exitCode = hits === 0 ? 0 : 1;
