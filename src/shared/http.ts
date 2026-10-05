/**
 * The plugin's HTTP boundary constants, shared by Host and Client.
 *
 * Both halves register and call the same routes outside the shell's `/api`
 * channel, so the guard header and prefix must be identical. They live here —
 * the only place both halves may import — so the two can never drift.
 * @module dsh-annotator/shared/http
 */

/** Request header every plugin route requires. */
export const GUARD_HEADER = 'x-dsh-annotator'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/dsh-annotator'
