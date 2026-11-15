import { targetBitrateKbps, peakBitrateKbps, type VideoSpec } from '../../shared/encodeQuality'

export { FALLBACK_SPEC, targetBitrateKbps, peakBitrateKbps, sourceSpec, timelineSpec, concatRenderSpec, type VideoSpec } from '../../shared/encodeQuality'

const BUFFER_RATIO = 2
/** NVENC constant-quality level (lower is better; 19 is visually transparent for most game captures). */
const NVENC_CQ = '19'
/** HEVC NVENC constant-quality level: HEVC reaches the same visual quality at a slightly higher CQ value than H.264. */
const HEVC_NVENC_CQ = '21'

/**
 * Video encoder arguments with explicit rate control. Without them, hardware encoders fall back to very low
 * defaults (NVENC encodes at about 2 Mbps), which makes precise exports look blurry.
 * `spec` is the OUTPUT spec (after reframing/resizing/frame-rate cap), so the bitrate follows what is actually encoded.
 * HEVC encoders use the same target bitrate as H.264 (so disk-space estimates stay valid) and the 8-bit Main profile.
 */
export function videoEncodeArgs(encoder: string, spec: VideoSpec): string[] {
  const kbps = targetBitrateKbps(spec)
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${peakBitrateKbps(spec)}k`, '-bufsize', `${kbps * BUFFER_RATIO}k`]
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', encoder, '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', NVENC_CQ, ...rate, '-spatial-aq', '1', '-profile:v', 'high']
    case 'h264_qsv':
      return ['-c:v', encoder, '-preset', 'slow', ...rate, '-profile:v', 'high']
    case 'h264_amf':
      return ['-c:v', encoder, '-quality', 'quality', '-rc', 'vbr_peak', ...rate, '-profile:v', 'high']
    case 'hevc_nvenc':
      return ['-c:v', encoder, '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', HEVC_NVENC_CQ, ...rate, '-spatial-aq', '1', '-profile:v', 'main']
    case 'hevc_qsv':
      return ['-c:v', encoder, '-preset', 'slow', ...rate, '-profile:v', 'main']
    case 'hevc_amf':
      return ['-c:v', encoder, '-quality', 'quality', '-rc', 'vbr_peak', ...rate, '-profile:v', 'main']
    case 'libopenh264':
      return ['-c:v', encoder, ...rate, '-allow_skip_frames', '0']
    default:
      return ['-c:v', encoder, ...rate]
  }
}
