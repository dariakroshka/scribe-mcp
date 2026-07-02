// Smoke test for the bundled media toolchain: resolve ffmpeg/ffprobe and run
// each with `-version`. Exits non-zero if either can't be spawned — catches a
// broken postinstall, a wrong platform package, or a missing trustedDependencies
// entry (the three ways this feature dies inside a container).
//
//   bun run smoke
import { FFMPEG, FFPROBE } from "../src/bins.js";

let failed = false;
for (const [name, bin] of [
  ["ffmpeg", FFMPEG],
  ["ffprobe", FFPROBE],
] as const) {
  try {
    const proc = Bun.spawn([bin, "-version"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`exit ${code}`);
    console.log(`✓ ${name}: ${out.split("\n")[0]}  (${bin})`);
  } catch (err) {
    failed = true;
    console.error(`✗ ${name} (${bin}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed ? 1 : 0);
