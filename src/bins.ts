// Resolved paths to scribe-mcp's bundled media toolchain.
//
// scribe ships its own ffmpeg/ffprobe (ffmpeg-static + @ffprobe-installer/ffprobe)
// so consumers don't need them on PATH or baked into the image's apt layer —
// `bun install` brings the binaries with the package. Falls back to a bare
// PATH lookup only if the static package didn't resolve a binary for this
// platform (defensive; the normal path is the bundled binary).
import ffmpegStatic from "ffmpeg-static";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

export const FFMPEG: string = (ffmpegStatic as string | null) ?? "ffmpeg";
export const FFPROBE: string = ffprobeInstaller?.path ?? "ffprobe";
