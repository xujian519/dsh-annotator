/**
 * Resolving the directory a Session's relative file paths are relative to.
 *
 * A preview address carries either an absolute path or one relative to the
 * addressed Session's workspace, and only the Host can turn the second form into
 * a real path. Three sources are tried in order of authority: the live Agent's
 * own Session header, the durable Session header on disk (a blank Session has no
 * live Agent), and the workspace that lists this Session. Every source is read
 * through `ctx.get`, so a composition that provides only some of them still
 * resolves absolute addresses.
 * @module dsh-annotator/host/session-cwd
 */

/** The live-agent directory, as this plugin reads it. */
export interface AgentsFace {
  get(id: string): { readonly session?: { readonly cwd?: string } } | undefined
}

/** Durable Session headers, as this plugin reads them. */
export interface SessionPersistenceFace {
  stat(id: string): Promise<{ readonly header?: { readonly cwd?: string } } | undefined>
}

/** The workspace registry, as this plugin reads it. */
export interface WorkspaceRegistryFace {
  list(): readonly { readonly path?: string; readonly sessionIds?: readonly string[] }[]
}

/** Every Host source this plugin may resolve a Session directory from. */
export interface SessionCwdSources {
  /** Live agents, when the composition provides the agent directory. */
  readonly agents?: AgentsFace | undefined
  /** Durable Session headers. */
  readonly sessionPersistence?: SessionPersistenceFace | undefined
  /** Workspace registrations, which list their Sessions. */
  readonly workspaceRegistry?: WorkspaceRegistryFace | undefined
}

/**
 * Resolve one Session's workspace directory.
 * @param sessionId - the Session named by a preview address.
 * @param sources - the Host sources available in this composition.
 * @returns the absolute directory, or undefined when no source knows it.
 */
export async function resolveSessionCwd(
  sessionId: string,
  sources: SessionCwdSources,
): Promise<string | undefined> {
  const live = sources.agents?.get(sessionId)?.session?.cwd
  if (live !== undefined && live !== '') return live
  try {
    const stored = await sources.sessionPersistence?.stat(sessionId)
    const cwd = stored?.header?.cwd
    if (cwd !== undefined && cwd !== '') return cwd
  } catch {
    // A Session the persistence backend cannot read is answered by the
    // workspace registry below rather than failing the whole request.
  }
  for (const workspace of sources.workspaceRegistry?.list() ?? []) {
    if (workspace.sessionIds?.includes(sessionId) === true && workspace.path !== undefined) return workspace.path
  }
  return undefined
}
