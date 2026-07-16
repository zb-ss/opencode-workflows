export const MAX_PUBLICATION_MARKER_ID_LENGTH: 64
export const MAX_PUBLICATION_MARKER_LITERAL_LENGTH: 256

export interface PublicationMarkerContract {
  readonly id: string
  readonly literal: string
  readonly case_sensitive: boolean
}

export interface PublicationMarkerIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
}

export function publicationMarkerIssues(
  markers: unknown,
  options?: { readonly requireNonEmpty?: boolean },
): PublicationMarkerIssue[]
