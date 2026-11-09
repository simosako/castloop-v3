import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const targets = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64", "bun-windows-x64"] as const;
type Target = typeof targets[number];

export function parseTargets(args: string[]): Target[] {
  if (args.length === 1 && args[0] === "--all") return [...targets];
  if (args.length === 2 && args[0] === "--target" && targets.includes(args[1] as Target)) return [args[1] as Target];
  throw new Error(`Use --all or --target <${targets.join(" | ")}>`);
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function buildRelease(selected: Target[]): Promise<void> {
  const root = resolve(import.meta.dir, "../../..");
  const outDir = resolve(root, "dist", "release");
  await mkdir(outDir, { recursive: true });
  const checksums: string[] = [];
  for (const target of selected) {
    const name = `castloop-${target.slice(4)}${target.startsWith("bun-windows-") ? ".exe" : ""}`;
    const path = resolve(outDir, name);
    const child = Bun.spawn([process.execPath, "build", resolve(root, "packages/cli/src/main.ts"), "--compile", `--target=${target}`, "--outfile", path], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error(`Build failed for ${target}`);
    checksums.push(`${await digest(path)}  ${name}`);
  }
  await writeFile(resolve(outDir, "SHA256SUMS"), checksums.join("\n") + "\n");
  console.log(`Built ${selected.length} target(s) in ${outDir}; cross-compiled binaries still require native-host verification.`);
}

if (import.meta.main) {
  try { await buildRelease(parseTargets(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
