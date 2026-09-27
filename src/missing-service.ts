/**
 * The one message a half-mounted plugin fails with.
 *
 * Both halves treat their collaborators as hard requirements, so the wording
 * lives here rather than in each entry, where the two copies would drift.
 * @module dsh-annotator/missing-service
 */

/**
 * Compose the message a missing service fails with.
 * @param service - the service name that was absent.
 * @returns the failure message.
 */
export function missingService(service: string): string {
  return `dsh-annotator: the composition provides no "${service}"; this plugin cannot mount without it`
}
