/**
 * Host half of the annotator.
 *
 * It owns everything the browser half cannot do itself: resolving a preview
 * address to a real path, reading and writing the annotation sidecar beside the
 * figure, and telling the agent how to consume an annotation message.
 *
 * Both services below are hard requirements. A composition that lacks either is
 * misconfigured for this plugin, and mounting half of it — routes without
 * guidance, or the reverse — would leave the agent reading messages nothing
 * explained, so `apply` reports the missing service instead of skipping it.
 *
 * Service access goes through `ctx.get(...)` with the structural types declared
 * below rather than imports from other DSH packages, so this package's runtime
 * carries no dependency on any harness package and cannot break on a version
 * skew.
 * @module dsh-annotator
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EDIT_GUIDANCE, EDIT_GUIDANCE_NAME, EDIT_GUIDANCE_ORDER, GUIDANCE, GUIDANCE_NAME, GUIDANCE_ORDER } from './host/guidance'
import { ROUTE_PREFIX, createHandlers } from './host/routes'
import { resolveSessionCwd, type AgentsFace, type SessionPersistenceFace, type WorkspaceRegistryFace } from './host/session-cwd'
import { missingService } from './missing-service'

/** Plugin name, as the Loader entry and diagnostics spell it. */
export const name = 'dsh-annotator'

/**
 * Services the host half cannot work without: the routes go on the Web server and
 * the guidance goes into the prompt registry. Declaring them here also makes the
 * Loader order this plugin after both.
 */
export const inject = ['webServer', 'systemPrompt']

/** One named route as `dsh-host-webserver` accepts it. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The prompt registry slice this plugin contributes to. */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string; stable?: boolean }): () => void
}

/**
 * Mount the host half.
 * @param ctx - the plugin's Cordis context.
 * @throws {Error} when a required service is missing from the composition.
 */
export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (webServer === undefined) throw new Error(missingService('webServer'))
  if (systemPrompt === undefined) throw new Error(missingService('systemPrompt'))
  const sources = {
    agents: ctx.get('agents') as AgentsFace | undefined,
    sessionPersistence: ctx.get('sessionPersistence') as SessionPersistenceFace | undefined,
    workspaceRegistry: ctx.get('workspaceRegistry') as WorkspaceRegistryFace | undefined,
  }
  const handlers = createHandlers({
    sessionCwd: (sessionId) => resolveSessionCwd(sessionId, sources),
  })
  ctx.effect(
    () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handlers.annotation }),
    'dsh-annotator: annotation route',
  )
  ctx.effect(
    () => systemPrompt.section({
      name: GUIDANCE_NAME,
      order: GUIDANCE_ORDER,
      text: GUIDANCE,
      stable: true,
    }),
    'dsh-annotator: guidance',
  )
  ctx.effect(
    () => systemPrompt.section({
      name: EDIT_GUIDANCE_NAME,
      order: EDIT_GUIDANCE_ORDER,
      text: EDIT_GUIDANCE,
      stable: true,
    }),
    'dsh-annotator: edit guidance',
  )
}
