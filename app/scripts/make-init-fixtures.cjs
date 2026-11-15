#!/usr/bin/env node
// Regenerates app/src/main/recording/__fixtures__/init-{h264,hevc,av1}.mp4: fragmented-MP4 initialization segments
// (ftyp + moov, cut before the first moof) like the ones the recorder writes. The files are tiny but match the repo's
// `*.mp4` ignore rule, so they are un-ignored by a .gitignore exception.
//
//   node scripts/make-init-fixtures.cjs [ffmpeg] [av1-ffmpeg]
//
// ffmpeg defaults to build/ffmpeg/bin/ffmpeg.exe (h264_nvenc, hevc_nvenc). AV1 NVENC needs an RTX 40-series GPU, so the
// AV1 fixture is made with libsvtav1 from a second ffmpeg (default: `ffmpeg` on PATH); mp4-codec only reads av1C.
// (libaom-av1 leaves av1C empty with empty_moov.) 640x360 makes SVT-AV1 pick level 2.1, matching the test's av01.0.01M.08.
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const ffmpeg = process.argv[2] || path.join(root, 'build', 'ffmpeg', 'bin', 'ffmpeg.exe')
const av1Ffmpeg = process.argv[3] || 'ffmpeg'
const outDir = path.join(__dirname, '..', 'src', 'main', 'recording', '__fixtures__')

const jobs = [
  { name: 'init-h264.mp4', bin: ffmpeg, codec: ['-c:v', 'h264_nvenc', '-profile:v', 'high'] },
  { name: 'init-hevc.mp4', bin: ffmpeg, codec: ['-c:v', 'hevc_nvenc', '-profile:v', 'main'] },
  { name: 'init-av1.mp4', bin: av1Ffmpeg, size: '640x360', codec: ['-c:v', 'libsvtav1', '-preset', '10', '-svtav1-params', 'log-level=0'] }
]

/** Byte offset of the first top-level `moof` box. */
function firstMoof(buf) {
  for (let off = 0; off + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(off)
    if (buf.toString('ascii', off + 4, off + 8) === 'moof') return off
    if (size < 8) break
    off += size
  }
  throw new Error('no moof box found')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-fixtures-'))
try {
  for (const job of jobs) {
    const full = path.join(tmp, job.name)
    execFileSync(job.bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${job.size || '320x240'}:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '1', '-pix_fmt', 'yuv420p', ...job.codec, '-c:a', 'aac',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', full
    ], { stdio: ['ignore', 'ignore', 'inherit'] })
    const buf = fs.readFileSync(full)
    const init = buf.subarray(0, firstMoof(buf))
    fs.writeFileSync(path.join(outDir, job.name), init)
    console.log(`${job.name}: ${init.length} bytes`)
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
