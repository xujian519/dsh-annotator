/** The browser entry: the three registrations, the injected props, and its failures. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AnnotatorBody } from '../src/client/AnnotatorBody'
import { BODY_ID, apply, inject, name } from '../src/client/index'
import { NAMESPACE, en, zh } from '../src/client/locales'
import { missingService } from '../src/missing-service'

/** One renderer definition the stub registry was asked to add. */
interface StubDefinition {
  readonly id: string
  readonly extensions: readonly string[]
  readonly binaryExtensions?: readonly string[]
  readonly priority?: string
  readonly title: () => string
  readonly loading: string
  readonly wrap?: boolean
}

/** One slot registration the stub registry was asked to add. */
interface StubSlot {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

/** A client context stub that records the three registrations. */
function stubContext(options: {
  readonly omit?: readonly string[]
  readonly localeId?: string | undefined
  readonly sessions?: unknown
} = {}): {
  readonly ctx: Context
  readonly definitions: StubDefinition[]
  readonly slots: StubSlot[]
  readonly dictionaries: Record<string, unknown>[]
  readonly injectedKeys: string[]
  readonly disposed: string[]
} {
  const omitted = new Set(options.omit ?? [])
  const definitions: StubDefinition[] = []
  const slots: StubSlot[] = []
  const dictionaries: Record<string, unknown>[] = []
  const injectedKeys: string[] = []
  const disposed: string[] = []
  const services: Record<string, unknown> = {
    locale: {
      register: (namespace: string, dicts: Record<string, unknown>) => {
        dictionaries.push({ namespace, ...dicts })
        return () => { disposed.push('dictionaries') }
      },
      bind: (namespace: string) => (key: string) => `${namespace}.${key}`,
      getLocale: () => (options.localeId === undefined ? {} : { locale: options.localeId }),
    },
    documentPreviews: {
      register: (definition: StubDefinition) => {
        definitions.push(definition)
        return () => { disposed.push('renderer') }
      },
    },
    slots: {
      inject: (key: string, callback: () => () => void) => {
        injectedKeys.push(key)
        return callback()
      },
      register: (slotOptions: Record<string, unknown>, component: unknown) => {
        slots.push({ options: slotOptions, component })
        return () => { disposed.push('body') }
      },
    },
    sessions: options.sessions,
  }
  const ctx = {
    get: (key: string) => (omitted.has(key) ? undefined : services[key]),
    effect: (factory: () => (() => void) | undefined) => factory() ?? (() => {}),
  } as unknown as Context
  return { ctx, definitions, slots, dictionaries, injectedKeys, disposed }
}

describe('browser entry', () => {
  it('is named after the package and declares its three hard services', () => {
    expect(name).toBe('dsh-annotator-client')
    expect(inject).toEqual(['slots', 'locale', 'documentPreviews'])
  })

  it('registers both dictionaries, the renderer metadata, and the slot body', () => {
    const stub = stubContext()
    apply(stub.ctx)
    expect(stub.dictionaries).toEqual([{ namespace: NAMESPACE, zh, en }])
    expect(stub.definitions).toHaveLength(1)
    expect(stub.definitions[0]).toMatchObject({
      id: BODY_ID,
      priority: 'extension',
      loading: 'bytes-complete',
      wrap: false,
    })
    expect(stub.definitions[0]?.extensions).toContain('svg')
    expect(stub.definitions[0]?.extensions).toContain('png')
    expect(stub.definitions[0]?.binaryExtensions).toContain('png')
    expect(stub.definitions[0]?.binaryExtensions).not.toContain('svg')
    expect(stub.injectedKeys).toEqual(['sidebar.right.tab.document'])
    expect(stub.slots[0]?.options).toMatchObject({
      name: 'sidebar.right.tab.document',
      key: BODY_ID,
      locale: NAMESPACE,
    })
    expect(stub.slots[0]?.component).toBe(AnnotatorBody)
  })

  it('lets the registry ask for the renderer title in the active locale', () => {
    const stub = stubContext()
    apply(stub.ctx)
    expect(stub.definitions[0]?.title()).toBe(`${NAMESPACE}.title`)
  })

  it('injects the session face, the session id, and the active locale id', () => {
    const sessions = { scope: () => undefined }
    const stub = stubContext({ localeId: 'en-US', sessions })
    apply(stub.ctx)
    const factory = stub.slots[0]?.options['inject']
    expect(typeof factory).toBe('function')
    const injected = (factory as (id: unknown) => unknown)(123)
    expect(injected).toEqual({ sessions, sessionId: '123', localeId: 'en-US' })
  })

  it('falls back to Chinese when the locale service reports no active locale', () => {
    const stub = stubContext()
    apply(stub.ctx)
    const factory = stub.slots[0]?.options['inject'] as (id: unknown) => { localeId: string }
    expect(factory('s1').localeId).toBe('zh')
  })

  it('reports an absent session service as undefined rather than guessing', () => {
    const stub = stubContext()
    apply(stub.ctx)
    const factory = stub.slots[0]?.options['inject'] as (id: unknown) => { sessions: unknown }
    expect(factory('s1').sessions).toBeUndefined()
  })

  it.each(['locale', 'documentPreviews', 'slots'])('fails loudly without the %s service', (service) => {
    const stub = stubContext({ omit: [service] })
    expect(() => { apply(stub.ctx) }).toThrow(missingService(service))
  })
})
