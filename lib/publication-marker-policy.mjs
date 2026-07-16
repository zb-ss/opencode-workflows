export const MAX_PUBLICATION_MARKER_ID_LENGTH = 64
export const MAX_PUBLICATION_MARKER_LITERAL_LENGTH = 256

const MARKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function publicationMarkerIssues(markers, options = {}) {
  if (!Array.isArray(markers)) {
    return [{ path: [], message: 'publication internal markers must be an array' }]
  }
  const issues = []
  if (options.requireNonEmpty && markers.length === 0) {
    issues.push({ path: [], message: 'at least one internal marker is required when publication is enabled' })
  }
  const ids = new Set()
  const literals = new Set()
  markers.forEach((marker, index) => {
    if (!marker || typeof marker !== 'object') {
      issues.push({ path: [index], message: 'publication internal marker must be an object' })
      return
    }
    if (typeof marker.id !== 'string'
      || marker.id.length > MAX_PUBLICATION_MARKER_ID_LENGTH
      || !MARKER_ID_PATTERN.test(marker.id)) {
      issues.push({ path: [index, 'id'], message: 'publication internal marker ID is invalid' })
    } else if (ids.has(marker.id)) {
      issues.push({ path: [index, 'id'], message: `duplicate publication marker ID: ${marker.id}` })
    }
    if (typeof marker.literal !== 'string'
      || marker.literal.length < 2
      || marker.literal.length > MAX_PUBLICATION_MARKER_LITERAL_LENGTH
      || marker.literal.includes('\0')) {
      issues.push({ path: [index, 'literal'], message: 'publication internal marker literal is invalid' })
    } else {
      const normalized = marker.literal.toLocaleLowerCase('en-US')
      if (literals.has(normalized)) {
        issues.push({
          path: [index, 'literal'],
          message: 'duplicate case-normalized publication marker literal',
        })
      }
      literals.add(normalized)
    }
    if (typeof marker.case_sensitive !== 'boolean') {
      issues.push({
        path: [index, 'case_sensitive'],
        message: 'publication internal marker case_sensitive must be boolean',
      })
    }
    if (typeof marker.id === 'string') ids.add(marker.id)
  })
  return issues
}
