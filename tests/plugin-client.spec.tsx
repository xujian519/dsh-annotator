/** The browser entry: the three registrations, the injected props, and its failures. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AnnotatorBody } from '../src/client/AnnotatorBody'
import { LazyPdfBody } from '../src/client/LazyPdfBody'
import { BODY_ID, MD_BODY_ID, PDF_BODY_ID, apply, inject, name } from '../src/client/index'
import { MarkdownBody } from '../src/client/markdown/MarkdownBody'
import { NAMESPACE, en, zh } from '../src/client/locales'
import { missingService } from '../src/missing-service'
import { defined } from './dom'

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
  readonly fileUpload?: unknown
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
    fileUpload: options.fileUpload,
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

  it('registers both dictionaries, all three renderer kinds, and all three bodies', () => {
    const stub = stubContext()
    apply(stub.ctx)
    expect(stub.dictionaries).toEqual([{ namespace: NAMESPACE, zh, en }])
    expect(stub.definitions).toHaveLength(3)
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
    // An extension-band PDF renderer is what keeps the shell's read-only preview
    // as the fallback in the renderer dropdown rather than the only option.
    expect(stub.definitions[1]).toMatchObject({
      id: PDF_BODY_ID,
      extensions: ['pdf'],
      binaryExtensions: ['pdf'],
      priority: 'extension',
      loading: 'bytes-complete',
      wrap: false,
    })
    // Markdown is a text-pages implementation: the owner hands it the source as
    // it reads it, and the body edits that text without ever writing the file.
    expect(stub.definitions[2]).toMatchObject({
      id: MD_BODY_ID,
      extensions: ['md', 'markdown'],
      priority: 'extension',
      loading: 'text-pages',
      wrap: true,
    })
    expect(stub.injectedKeys).toEqual([
      'sidebar.right.tab.document', 'sidebar.right.tab.document', 'sidebar.right.tab.document',
    ])
    expect(stub.slots[2]?.options).toMatchObject({
      name: 'sidebar.right.tab.document',
      key: MD_BODY_ID,
      locale: NAMESPACE,
    })
    expect(stub.slots[2]?.component).toBe(MarkdownBody)
    expect(stub.slots[0]?.options).toMatchObject({
      name: 'sidebar.right.tab.document',
      key: BODY_ID,
      locale: NAMESPACE,
    })
    expect(stub.slots[0]?.component).toBe(AnnotatorBody)
    expect(stub.slots[1]?.options).toMatchObject({
      name: 'sidebar.right.tab.document',
      key: PDF_BODY_ID,
      locale: NAMESPACE,
    })
    expect(stub.slots[1]?.component).toBe(LazyPdfBody)
  })

  it('lets the registry ask for each renderer title in the active locale', () => {
    const stub = stubContext()
    apply(stub.ctx)
    expect(stub.definitions[0]?.title()).toBe(`${NAMESPACE}.title`)
    expect(stub.definitions[1]?.title()).toBe(`${NAMESPACE}.pdfTitle`)
    expect(stub.definitions[2]?.title()).toBe(`${NAMESPACE}.mdTitle`)
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

  it('hands the Markdown editor the upload service a long difference needs', () => {
    const sessions = { scope: () => undefined }
    const fileUpload = { upload: () => undefined }
    const stub = stubContext({ sessions, fileUpload })
    apply(stub.ctx)
    const factory = stub.slots[2]?.options['inject'] as (id: unknown) => unknown
    expect(factory(7)).toEqual({ sessions, fileUpload, sessionId: '7', localeId: 'zh' })
  })

  it('leaves the Markdown editor without an upload service the composition omits', () => {
    const stub = stubContext()
    apply(stub.ctx)
    const factory = stub.slots[2]?.options['inject'] as (id: unknown) => { fileUpload: unknown }
    expect(factory('s1').fileUpload).toBeUndefined()
  })

  it('hands the PDF chunk the seats it cannot import from this bundle', () => {
    const stub = stubContext()
    apply(stub.ctx)
    const factory = stub.slots[1]?.options['inject'] as (id: unknown) => { AnnotatorBody: unknown; seat: Record<string, unknown> }
    // The chunk cannot import its own package's entry bundle, so the component it
    // mounts per page, and the seat that reads, writes and delivers the document,
    // arrive through the injection rather than through an import.
    const injected = factory('s1')
    expect(injected.AnnotatorBody).toBe(AnnotatorBody)
    expect(Object.keys(injected.seat).sort()).toEqual(['load', 'save', 'send'])
  })

  it('builds the seat in the active locale, so a sent document speaks it', async () => {
    const calls: string[] = []
    const prompts: unknown[][] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return { json: async () => ({ ok: true, annotationPath: '/w/a.annot.json', reviewPath: null }), status: 200 }
    })
    const sessions = {
      scope: () => ({ live: true }),
      sessionOf: () => ({ prompt: async (content: readonly unknown[]) => { prompts.push([...content]); return { ok: true } } }),
    }
    const stub = stubContext({ localeId: 'en-GB', sessions })
    apply(stub.ctx)
    const factory = stub.slots[1]?.options['inject'] as (id: unknown) => { seat: { send: (input: unknown, saved: unknown, pages: unknown, pdf: unknown) => Promise<readonly string[]> } }
    const seat = factory('s1').seat
    const document_ = {
      figure: { address: 'a', path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), pageCount: 2 },
      marks: [{ id: 'm1', kind: 'rect', color: '#1971c2', points: [[1, 2], [3, 4]], page: 1 }],
      summary: '',
      createdAt: null,
    }
    const warnings = await seat.send(document_, { annotationPath: '/w/a.annot.json', reviewPath: null }, [], new Uint8Array([1]))
    // The seat speaks the locale the slot was mounted under, and the composition
    // here provides no upload service.
    expect(warnings).toEqual(['This composition has no upload service, so the annotated PDF was not attached.'])
    expect(calls).toEqual([])
    const parts = (prompts[0] ?? []) as { readonly text?: string }[]
    expect(defined(parts[0]).text).toContain('[figure annotations]')
    vi.unstubAllGlobals()
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
