/** The host entry: what it mounts, and the loud failure a missing service gets. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index'
import { GUIDANCE, GUIDANCE_NAME, GUIDANCE_ORDER } from '../src/host/guidance'
import { GUARD_HEADER, ROUTE_PREFIX } from '../src/host/routes'
import { missingService } from '../src/missing-service'

/** One route the stub Web server was asked to serve. */
interface StubRoute {
  readonly kind: string
  readonly path: string
  readonly handler: unknown
}

/** One prompt section the stub registry was asked to contribute. */
interface StubSection {
  readonly name: string
  readonly order: number
  readonly text: string
  readonly stable?: boolean
}

/** A Cordis context stub that records what the plugin mounts. */
function stubContext(options: { readonly omit?: readonly string[] } = {}): {
  readonly ctx: Context
  readonly routes: StubRoute[]
  readonly sections: StubSection[]
  readonly labels: string[]
  readonly disposed: string[]
} {
  const omitted = new Set(options.omit ?? [])
  const routes: StubRoute[] = []
  const sections: StubSection[] = []
  const labels: string[] = []
  const disposed: string[] = []
  const services: Record<string, unknown> = {
    webServer: {
      register: (route: StubRoute) => { routes.push(route); return () => { disposed.push('route') } },
    },
    systemPrompt: {
      section: (section: StubSection) => { sections.push(section); return () => { disposed.push('guidance') } },
    },
  }
  const ctx = {
    get: (key: string) => (omitted.has(key) ? undefined : services[key]),
    effect: (factory: () => (() => void) | undefined, label: string) => {
      labels.push(label)
      return factory() ?? (() => {})
    },
  } as unknown as Context
  return { ctx, routes, sections, labels, disposed }
}

describe('host entry', () => {
  it('is named after the package and declares both hard services', () => {
    expect(name).toBe('dsh-annotator')
    expect(inject).toEqual(['webServer', 'systemPrompt'])
  })

  it('mounts the guard-protected route prefix and the agent guidance', () => {
    const stub = stubContext()
    apply(stub.ctx)
    expect(stub.routes).toHaveLength(1)
    expect(stub.routes[0]).toMatchObject({ kind: 'prefix', path: ROUTE_PREFIX })
    expect(typeof stub.routes[0]?.handler).toBe('function')
    expect(stub.sections).toEqual([{
      name: GUIDANCE_NAME,
      order: GUIDANCE_ORDER,
      text: GUIDANCE,
      stable: true,
    }])
    expect(stub.labels).toEqual(['dsh-annotator: annotation route', 'dsh-annotator: guidance'])
  })

  it('registers both contributions through ctx.effect, so they can be taken back', () => {
    const stub = stubContext()
    apply(stub.ctx)
    expect(stub.disposed).toEqual([])
  })

  it('fails loudly when the composition provides no Web server', () => {
    const stub = stubContext({ omit: ['webServer'] })
    expect(() => { apply(stub.ctx) }).toThrow(missingService('webServer'))
  })

  it('fails loudly when the composition provides no prompt registry', () => {
    const stub = stubContext({ omit: ['systemPrompt'] })
    expect(() => { apply(stub.ctx) }).toThrow(missingService('systemPrompt'))
  })

  it('names the missing service in the message', () => {
    expect(missingService('locale')).toContain('"locale"')
    expect(missingService('locale')).toContain('dsh-annotator')
  })

  it('serves the registered route through the composition’s own session lookup', async () => {
    const stub = stubContext()
    apply(stub.ctx)
    const handler = stub.routes[0]?.handler as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const req = {
      method: 'GET',
      url: `${ROUTE_PREFIX}/annotation?address=${encodeURIComponent('dsh-resource://file/session/s1/fig1.svg')}`,
      headers: { [GUARD_HEADER]: '1' },
      async *[Symbol.asyncIterator]() { /* a GET carries no body */ },
    } as unknown as IncomingMessage
    let status = 200
    let text = ''
    const res = {
      writeHead: (code: number) => { status = code; return res },
      end: (payload?: string) => { text = payload ?? ''; return res },
    } as unknown as ServerResponse
    await handler(req, res)
    // The stub composition provides no agent directory, no persistence, and no
    // workspace registry, so a relative address cannot be resolved.
    expect(status).toBe(404)
    expect(JSON.parse(text)).toMatchObject({ error: expect.stringContaining('cannot resolve') as unknown as string })
  })
})
