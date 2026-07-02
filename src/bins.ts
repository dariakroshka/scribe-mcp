// Resolved paths to scribe-mcp's bundled media toolchain.
//
// scribe ships its own ffmpeg/ffprobe (ffmpeg-static + @ffprobe-installer/ffprobe)
// so consumers don't need them on PATH or baked into the image's apt layer —
// `bun install` brings the binaries with the package. Falls back to a bare
// PATH lookup only if the static package didn't resolve a binary for this
// platform (defensive; the normal path is the bundled binary).
import ffmpegStatic from "ffmpeg-static";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

function resolveBinary(bundled: string | null | undefined, name: string): string {
  if (bundled) return bundled;
  // stderr, not stdout — this is a stdio MCP. Surface the fallback here rather
  // than letting it fail later as a bare ENOENT three files away at a spawn.
  process.stderr.write(
    `[scribe] bundled ${name} unavailable for ${process.platform}/${process.arch}; ` +
      `falling back to \`${name}\` on PATH\n`,
  );
  return name;
}

export const FFMPEG: string = resolveBinary(ffmpegStatic as string | null, "ffmpeg");
export const FFPROBE: string = resolveBinary(ffprobeInstaller?.path, "ffprobe");
