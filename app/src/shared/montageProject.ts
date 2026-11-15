/**
 * Builds the Studio project for a montage (phase 2 contract; subagent C implements the body, signature fixed).
 * The project is a normal `StoredProject` shape, so export (`buildJobs`) and Studio both accept it.
 */
import type { ProjectItem } from '../renderer/editor/project'
import type { Clip } from './types'

export interface MontageProjectInput {
  /** `montageProjectId(job.id)`. */
  projectId: string
  /** Display name, e.g. "Montage – Valorant_2026-11-15_21-08". */
  name: string
  sourcePath: string
  /** Output of `selectMontageClips`, chronological. */
  clips: Clip[]
}

export interface MontageProject {
  id: string
  version: 1
  name: string
  items: ProjectItem[]
}

/** One project item per clip, in order; `clipId` links each item to its cache clip so Studio keeps them in sync. */
export function buildMontageProject(input: MontageProjectInput): MontageProject {
  return {
    id: input.projectId,
    version: 1,
    name: input.name,
    items: input.clips.map((c, i) => ({ id: `${input.projectId}_i${i}`, source: input.sourcePath, start: c.start, end: c.end, clipId: c.id }))
  }
}
