/**
 * Builds the Studio project for a montage (phase 2 contract; subagent C implements the body, signature fixed).
 * The project is a normal `StoredProject` shape, so export (`buildJobs`) and Studio both accept it.
 */
import { PROJECT_VERSION, type ProjectItem } from '../renderer/editor/project'
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
  version: typeof PROJECT_VERSION
  name: string
  items: ProjectItem[]
}

const validRange = (c: Clip): boolean =>
  typeof c.start === 'number' && typeof c.end === 'number' && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start

/**
 * One project item per clip, in the given order; `clipId` links each item to its cache clip so Studio keeps them in sync.
 * Item ids are `<projectId>_i<n>` with n counting the items actually written (0-based). Every item passes
 * `projectShapeError`: clips with a non-finite or empty range are left out, a clip without an id gets no `clipId`,
 * and an empty `sourcePath` yields no items (an item needs a source). Empty input gives a valid project with no items.
 */
export function buildMontageProject(input: MontageProjectInput): MontageProject {
  const items: ProjectItem[] = []
  if (typeof input.sourcePath === 'string' && input.sourcePath.length > 0) {
    for (const c of input.clips ?? []) {
      if (!c || !validRange(c)) continue
      items.push({
        id: `${input.projectId}_i${items.length}`,
        source: input.sourcePath,
        start: Math.max(0, c.start),
        end: c.end,
        ...(typeof c.id === 'string' && c.id.length > 0 ? { clipId: c.id } : {})
      })
    }
  }
  return { id: input.projectId, version: PROJECT_VERSION, name: typeof input.name === 'string' ? input.name : '', items }
}
