// Feature 009 helper: spawn the real seller entry point the way the demo does (only PATH, HOME, NODE_*
// and ENV_FILE), wait until it listens or exits, and return its output.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export interface SellerRun {
  /** Exit code, or null when it listened and was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function runSeller(envFileText: string): Promise<SellerRun> {
  const dir = mkdtempSync(join(tmpdir(), "x402-seller-"));
  const envFile = join(dir, "seller.env");
  writeFileSync(envFile, `${envFileText}\nSELLER_PORT=${await freePort()}\n`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ENV_FILE: envFile };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("NODE_") && v !== undefined) env[k] = v;
  const child = spawn("node_modules/.bin/tsx", ["src/counterparty/seller.ts"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((resolve) => {
    const timer = setInterval(() => {
      if (stdout.includes("seller listening")) {
        clearInterval(timer);
        try {
          process.kill(-child.pid!, "SIGKILL"); // the process group: tsx runs node in a child
        } catch {
          // already gone
        }
      }
    }, 50);
    child.once("exit", (c) => {
      clearInterval(timer);
      resolve(c);
    });
  });
  rmSync(dir, { recursive: true, force: true });
  return { code, stdout, stderr };
}
