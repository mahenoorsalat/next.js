export type ValidationBoundaryTracking = {
  /**
   * Map from boundary id (the SegmentPath where a validation boundary is
   * placed) to the file paths of modules inside that boundary's subtree.
   * When the boundary spans multiple parallel slots, each slot contributes
   * its own first-found module path so all unrendered segments can be
   * reported together.
   */
  requiredIds: Map<string, string[]>
  /**
   * Source-defined route labels for each boundary. Unlike the boundary id,
   * these do not contain dynamic parameter or search parameter values.
   */
  boundaryLabels: Map<string, string>
  renderedIds: Set<string>
}

export function createValidationBoundaryTracking(): ValidationBoundaryTracking {
  return {
    requiredIds: new Map(),
    boundaryLabels: new Map(),
    renderedIds: new Set(),
  }
}

export function allRequiredBoundariesRendered(
  state: ValidationBoundaryTracking
): boolean {
  for (const id of state.requiredIds.keys()) {
    if (!state.renderedIds.has(id)) {
      return false
    }
  }
  return true
}
