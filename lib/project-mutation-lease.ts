import fs from 'node:fs'
import path from 'node:path'

interface ProjectLeaseState {
  exclusive: 'publication' | 'review' | null
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

function releaseLease(key: string, kind: 'publication' | 'review' | 'mutation'): void {
  const state = projectLeases.get(key)
  if (!state) throw new Error('project mutation lease was already released')
  if (kind === 'review' || kind === 'publication') state.exclusive = null
  else state.mutations--
  if (state.exclusive === null && state.mutations === 0) projectLeases.delete(key)
}

export function acquireProjectReviewLease(directory: string): () => void {
  const key = projectKey(directory)
  const state = projectLeases.get(key) ?? { exclusive: null, mutations: 0 }
  if (state.exclusive !== null || state.mutations > 0) {
    throw new Error('project content is already being reviewed or mutated')
  }
  state.exclusive = 'review'
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
  const state = projectLeases.get(key) ?? { exclusive: null, mutations: 0 }
  if (state.exclusive === 'review') throw new Error('project content is locked for fixed-point review')
  if (state.exclusive === 'publication') throw new Error('project content is locked for guarded publication')
  state.mutations++
  projectLeases.set(key, state)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseLease(key, 'mutation')
  }
}

export function acquireProjectPublicationLease(directory: string): () => void {
  const key = projectKey(directory)
  const state = projectLeases.get(key) ?? { exclusive: null, mutations: 0 }
  if (state.exclusive !== null || state.mutations > 0) {
    throw new Error('project content is already being reviewed, published, or mutated')
  }
  state.exclusive = 'publication'
  projectLeases.set(key, state)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseLease(key, 'publication')
  }
}
