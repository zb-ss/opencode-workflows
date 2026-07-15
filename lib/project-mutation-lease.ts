import fs from 'node:fs'
import path from 'node:path'

interface ProjectLeaseState {
  hasReview: boolean
  mutations: number
}

const projectLeases = new Map<string, ProjectLeaseState>()

function projectKey(directory: string): string {
  try {
    return path.resolve(fs.realpathSync(directory))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(directory)
    throw error
  }
}

function releaseLease(key: string, kind: 'review' | 'mutation'): void {
  const state = projectLeases.get(key)
  if (!state) throw new Error('project mutation lease was already released')
  if (kind === 'review') state.hasReview = false
  else state.mutations--
  if (!state.hasReview && state.mutations === 0) projectLeases.delete(key)
}

export function acquireProjectReviewLease(directory: string): () => void {
  const key = projectKey(directory)
  const state = projectLeases.get(key) ?? { hasReview: false, mutations: 0 }
  if (state.hasReview || state.mutations > 0) {
    throw new Error('project content is already being reviewed or mutated')
  }
  state.hasReview = true
  projectLeases.set(key, state)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseLease(key, 'review')
  }
}

export function acquireProjectMutationLease(directory: string): () => void {
  const key = projectKey(directory)
  const state = projectLeases.get(key) ?? { hasReview: false, mutations: 0 }
  if (state.hasReview) throw new Error('project content is locked for fixed-point review')
  state.mutations++
  projectLeases.set(key, state)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseLease(key, 'mutation')
  }
}
