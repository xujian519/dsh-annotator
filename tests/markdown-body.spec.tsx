// @vitest-environment jsdom
/** The Markdown body: editing the source, the difference against it, and the one delivery. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownBody, type MarkdownBodyProps } from '../src/client/markdown/MarkdownBody'
import { en, zh } from '../src/client/locales'
import type { SessionsLike } from '../src/client/session'
import { defined } from './dom'

const ADDRESS = 'dsh-resource://file/session/s1/docs/report.md'
const ABSOLUTE_ADDRESS = 'dsh-resource://file/absolute//w/report.md'

/** One content part handed to the session. */
interface Part {
  readonly type: string
  readonly text?: string
  readonly attachment?: { readonly attachmentId: string }
}

/** The text of the document the specs edit. */
const SOURCE = 'title\n\nbody\n'

/** A long document, and an edit of it whose changes are far enough apart to be many hunks. */
function wideTexts(): { readonly before: string; readonly after: string } {
  const before = Array.from({ length: 400 }, (_, index) => `line ${index}`)
  const after = [...before]
  for (let index = 5; index < 400; index += 8) after[index] = `changed ${index}`
  return { before: before.join('\n'), after: after.join('\n') }
}

/** A sessions stub that records what the body delivered. */
function stubSessions(outcome: 'ok' | 'noSession' | 'refuses' | 'throwsText' = 'ok'): {
  readonly sessions: SessionsLike | undefined
  readonly prompts: Part[][]
} {
  const prompts: Part[][] = []
  if (outcome === 'noSession') return { sessions: undefined, prompts }
  if (outcome === 'refuses') {
    return {
      prompts,
      sessions: {
        scope: () => ({ live: true }),
        sessionOf: () => ({ prompt: async (content: readonly unknown[]) => { prompts.push(content as Part[]); return { ok: false, error: { message: 'session is closed' } } } }),
        using: async () => { throw new Error('unused') },
      } as unknown as SessionsLike,
    }
  }
  if (outcome === 'throwsText') {
    return {
      prompts,
      sessions: {
        scope: () => ({ live: true }),
        sessionOf: () => ({ prompt: async () => { throw 'plain text failure' } }),
        using: async () => { throw new Error('unused') },
      } as unknown as SessionsLike,
    }
  }
  return {
    prompts,
    sessions: {
      scope: () => ({ live: true }),
      sessionOf: () => ({ prompt: async (content: readonly unknown[]) => { prompts.push(content as Part[]); return { ok: true } } }),
      using: async () => { throw new Error('unused') },
    } as unknown as SessionsLike,
  }
}

/** A sessions stub whose answer the spec releases by hand. */
function gatedSessions(): {
  readonly sessions: SessionsLike
  readonly prompts: Part[][]
  readonly release: () => void
} {
  const prompts: Part[][] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  return {
    prompts,
    release,
    sessions: {
      scope: () => ({ live: true }),
      sessionOf: () => ({
        prompt: async (content: readonly unknown[]) => {
          prompts.push(content as Part[])
          await gate
          return { ok: true }
        },
      }),
      using: async () => { throw new Error('unused') },
    } as unknown as SessionsLike,
  }
}

/** Mount the body and let its effects settle. */
async function mountBody(props: Partial<MarkdownBodyProps> = {}): Promise<{ readonly host: HTMLElement; readonly root: Root }> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<MarkdownBody content={{ kind: 'text', text: SOURCE, eof: true }} resourceAddress={ADDRESS} {...props} />)
  })
  return { host, root }
}

/** Re-render one mounted body with new props. */
async function rerender(root: Root, props: Partial<MarkdownBodyProps>): Promise<void> {
  await act(async () => {
    root.render(<MarkdownBody content={{ kind: 'text', text: SOURCE, eof: true }} resourceAddress={ADDRESS} {...props} />)
  })
}

/** Find one toolbar button by its own label. */
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent === label)
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

/** The body's textarea. */
function editor(host: HTMLElement): HTMLTextAreaElement {
  return defined(host.querySelector('textarea')) as HTMLTextAreaElement
}

/** Click one element inside act, letting the handler's promises settle. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

/** Type into the editor inside act. */
async function type(host: HTMLElement, value: string): Promise<void> {
  const element = editor(host)
  await act(async () => {
    // React tracks the last value it wrote, so the prototype's own setter has to
    // be the one that changes it; assigning `.value` would look like no change.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value)
    editor(host).dispatchEvent(new Event('input', { bubbles: true }))
    for (let turn = 0; turn < 2; turn += 1) await Promise.resolve()
  })
}

/** Put the caret at one offset and let the body read it. */
async function caretTo(host: HTMLElement, position: number, event = 'keyup'): Promise<void> {
  const element = editor(host)
  await act(async () => {
    element.setSelectionRange(position, position)
    element.dispatchEvent(new Event(event, { bubbles: true }))
    await Promise.resolve()
  })
}

/** Type one note into the hunk that starts at a baseline line. */
async function noteOn(host: HTMLElement, text: string, index = 0): Promise<void> {
  const field = [...host.querySelectorAll('.da-diff-note input')][index]
  if (field === undefined) throw new Error('no hunk note field')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

/** Install a clipboard the body can write to. */
function stubClipboard(outcome: 'ok' | 'refused' | 'throws-text' = 'ok'): { readonly written: string[] } {
  const written: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (outcome === 'refused') throw new Error('denied')
        if (outcome === 'throws-text') throw 'plain clipboard failure'
        written.push(text)
      },
    },
  })
  return { written }
}

let mounted: Root | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  document.body.innerHTML = ''
  // jsdom keeps one global per file, so a clipboard a spec installed would
  // otherwise outlive it and the "no clipboard" spec would never see none.
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('reading a document', () => {
  it('waits for text the owner has not delivered yet', async () => {
    // No address at all: the body still has to render, and it has nothing to edit.
    const { host } = await mountBody({ content: undefined, resourceAddress: undefined })
    mounted = createRoot(document.createElement('div'))
    expect(host.textContent).toContain(zh.editLoading)
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('waits for text when the owner delivered bytes instead', async () => {
    const { host } = await mountBody({ content: { kind: 'bytes' } })
    expect(host.textContent).toContain(zh.editLoading)
  })

  it('edits an empty document too, counting zero lines', async () => {
    const { host } = await mountBody({ content: { kind: 'text', eof: true } })
    expect(editor(host).value).toBe('')
    expect(host.textContent).toContain('共 0 行')
  })

  it('speaks the locale seat the shell bound, and the local dictionary without one', async () => {
    const { host } = await mountBody({ t: (key) => `T:${key}` })
    expect(host.textContent).toContain('T:editMode')
    expect(button(host, 'T:discardEdit')).toBeDefined()
  })

  it('hands the shell the document toolbar’s wrap preference', async () => {
    const { host } = await mountBody({ wrap: false })
    expect(editor(host).getAttribute('wrap')).toBe('off')
    const { host: wrapped } = await mountBody({ wrap: true })
    expect(editor(wrapped).getAttribute('wrap')).toBe('soft')
  })

  it('says the file is not fully loaded yet, and stops saying it at the end', async () => {
    const { host } = await mountBody({ content: { kind: 'text', text: SOURCE, eof: false } })
    expect(host.textContent).toContain(zh.editEofPending)
    const { host: complete } = await mountBody({ content: { kind: 'text', text: SOURCE, eof: true } })
    expect(complete.textContent).not.toContain(zh.editEofPending)
  })
})

describe('editing the source', () => {
  it('counts the loaded lines until something is edited', async () => {
    const { host } = await mountBody()
    expect(editor(host).value).toBe(SOURCE)
    // Three lines: the trailing newline is the file's end, not a line of its own.
    expect(host.textContent).toContain('共 3 行')
  })

  it('reports the difference as hunks and line counts once it is edited', async () => {
    const { host } = await mountBody()
    await type(host, 'title\n\nchanged body\n')
    expect(host.textContent).toContain('改动 1 处 · +1 −1 行')
  })

  it('draws the difference with both sides’ line numbers', async () => {
    const { host } = await mountBody()
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.diffMode))
    expect(host.querySelectorAll('.da-diff-hunk')).toHaveLength(1)
    expect(host.textContent).toContain('@@ -1,3 +1,3 @@')
    const lines = [...host.querySelectorAll('.da-diff-line')]
    expect(lines.map(line => line.getAttribute('data-kind'))).toEqual(['context', 'context', 'remove', 'add'])
    expect(defined(lines[2]).textContent).toContain('-body')
    expect(defined(lines[3]).textContent).toContain('+changed body')
    // And back to the editor, with the edit still in hand.
    await click(button(host, zh.editMode))
    expect(editor(host).value).toBe('title\n\nchanged body\n')
  })

  it('says there is no difference before anything is edited', async () => {
    const { host } = await mountBody()
    await click(button(host, zh.diffMode))
    expect(host.textContent).toContain(zh.diffEmpty)
  })

  it('goes back to the loaded text when the edit is discarded', async () => {
    const { host } = await mountBody()
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.discardEdit))
    expect(editor(host).value).toBe(SOURCE)
    // Three lines: the trailing newline is the file's end, not a line of its own.
    expect(host.textContent).toContain('共 3 行')
  })

  it('keeps the edit while the document is read further, and warns it is against an older version', async () => {
    const { host, root } = await mountBody({ content: { kind: 'text', text: SOURCE, eof: false } })
    mounted = root
    await type(host, 'title\n\nmine\n')
    await rerender(root, { content: { kind: 'text', text: `${SOURCE}more\n`, eof: true } })
    expect(host.textContent).toContain(zh.editStale)
    expect(editor(host).value).toBe('title\n\nmine\n')
  })

  it('says nothing about a stale version when the text changes with no edit in hand', async () => {
    const { host, root } = await mountBody()
    mounted = root
    await rerender(root, { content: { kind: 'text', text: 'other\n', eof: true } })
    expect(host.textContent).not.toContain(zh.editStale)
    expect(editor(host).value).toBe('other\n')
  })

  it('drops an edit when the tab moves to another document', async () => {
    const { host, root } = await mountBody()
    mounted = root
    await type(host, 'title\n\nmine\n')
    await rerender(root, { content: { kind: 'text', text: 'second\n', eof: true }, resourceAddress: 'dsh-resource://file/session/s1/docs/other.md' })
    expect(editor(host).value).toBe('second\n')
    expect(host.textContent).not.toContain(zh.editStale)
    expect(host.textContent).toContain('共 1 行')
  })
})

describe('delivering the difference', () => {
  it('sends the difference as one text part and reports that nothing was written', async () => {
    const stub = stubSessions()
    const { host, root } = await mountBody({ sessions: stub.sessions, sessionId: 's1' })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.sendEdit))
    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]).toHaveLength(1)
    expect(stub.prompts[0]?.[0]?.text).toContain('【文档修改建议】docs/report.md')
    expect(stub.prompts[0]?.[0]?.text).toContain('-body')
    expect(host.textContent).toContain(zh.editSent)
  })

  it('shows that it is sending while the session has not answered', async () => {
    const stub = gatedSessions()
    const { host, root } = await mountBody({ sessions: stub.sessions, sessionId: 's1' })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.sendEdit))
    expect(host.textContent).toContain(zh.editSending)
    await act(async () => {
      stub.release()
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    })
    expect(host.textContent).toContain(zh.editSent)
  })

  it('sends nothing when there is no difference to send', async () => {
    const stub = stubSessions()
    const { host, root } = await mountBody({ sessions: stub.sessions, sessionId: 's1' })
    mounted = root
    await click(button(host, zh.sendEdit))
    await type(host, 'title\n\nchanged body\n')
    await type(host, SOURCE)
    await click(button(host, zh.sendEdit))
    expect(stub.prompts).toEqual([])
    expect(host.textContent).not.toContain(zh.editSent)
  })

  it('takes the session from the address when the slot injected none', async () => {
    const stub = stubSessions()
    const { host, root } = await mountBody({ sessions: stub.sessions })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.sendEdit))
    expect(stub.prompts).toHaveLength(1)
  })

  it('reports a composition with no session service', async () => {
    const { host, root } = await mountBody({ sessions: undefined })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.sendEdit))
    expect(host.textContent).toContain(zh.editUnavailable)
  })

  it('reports an address that names no session', async () => {
    const stub = stubSessions()
    const { host, root } = await mountBody({
      sessions: stub.sessions,
      sessionId: undefined,
      resourceAddress: ABSOLUTE_ADDRESS,
    })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.sendEdit))
    expect(host.textContent).toContain(zh.editNoSession)
    expect(stub.prompts).toEqual([])
  })

  it('reports the reason the session gave for refusing', async () => {
    const stub = stubSessions('refuses')
    const { host, root } = await mountBody({ sessions: stub.sessions, sessionId: 's1' })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.sendEdit))
    expect(host.textContent).toContain(`${zh.editSendError}session is closed`)
  })

  it('reports a failure that is not an Error as its own text', async () => {
    const stub = stubSessions('throwsText')
    const { host, root } = await mountBody({ sessions: stub.sessions, sessionId: 's1' })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.sendEdit))
    expect(host.textContent).toContain('plain text failure')
  })

  it('warns in the status when a long difference could not be attached', async () => {
    const stub = stubSessions()
    const wide = wideTexts()
    const { host, root } = await mountBody({
      sessions: stub.sessions,
      sessionId: 's1',
      fileUpload: undefined,
      content: { kind: 'text', text: wide.before, eof: true },
    })
    mounted = root
    await type(host, wide.after)
    await click(button(host, zh.sendEdit))
    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]?.[0]?.text).toContain('另有')
    expect(host.textContent).toContain('本次组合没有附件服务')
  })

  it('speaks English in the message when the locale seat says so', async () => {
    const stub = stubSessions()
    const { host, root } = await mountBody({ sessions: stub.sessions, sessionId: 's1', localeId: 'en-GB' })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, en.sendEdit))
    expect(stub.prompts[0]?.[0]?.text).toContain('[document edits] docs/report.md')
    expect(host.textContent).toContain(en.editSent)
  })
})

describe('reading the source', () => {
  it('reads the caret out of the editor', async () => {
    const { host } = await mountBody()
    expect(host.textContent).toContain('第 1 行 · 第 1 列')
    // Past "title": still line one, sixth column.
    await caretTo(host, 5)
    expect(host.textContent).toContain('第 1 行 · 第 6 列')
    // Past the blank line: line three, first column.
    await caretTo(host, 7)
    expect(host.textContent).toContain('第 3 行 · 第 1 列')
    // A click moves the caret too.
    await caretTo(host, 2, 'click')
    expect(host.textContent).toContain('第 1 行 · 第 3 列')
  })

  it('numbers the lines while the wrap preference is off, and not while it is on', async () => {
    const { host } = await mountBody({ wrap: false })
    const numbers = [...host.querySelectorAll('.da-md-gutter div')].map((el) => el.textContent)
    expect(numbers).toEqual(['1', '2', '3'])
    expect(editor(host).getAttribute('wrap')).toBe('off')
    const { host: wrapped } = await mountBody({ wrap: true })
    expect(wrapped.querySelector('.da-md-gutter')).toBeNull()
  })

  it('keeps the gutter on the row the textarea is showing', async () => {
    const { host } = await mountBody({ wrap: false })
    const gutter = host.querySelector('.da-md-gutter') as HTMLElement
    await act(async () => {
      const area = editor(host)
      area.scrollTop = 42
      area.dispatchEvent(new Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    expect(gutter.scrollTop).toBe(42)
    // Without a gutter (wrapping on) a scroll is simply nothing to do.
    const { host: wrapped } = await mountBody({ wrap: true })
    await act(async () => {
      wrapped.dispatchEvent(new Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    expect(wrapped.querySelector('.da-md-gutter')).toBeNull()
  })
})

describe('copying the difference', () => {
  it('puts the whole unified diff on the clipboard', async () => {
    const clipboard = stubClipboard()
    const { host, root } = await mountBody()
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.copyDiff))
    expect(clipboard.written).toHaveLength(1)
    expect(clipboard.written[0]).toContain('--- a/report.md')
    expect(clipboard.written[0]).toContain('-body')
    expect(clipboard.written[0]).toContain('+changed body')
    expect(host.textContent).toContain(zh.diffCopied)
  })

  it('reports an environment that has no clipboard at all', async () => {
    const { host, root } = await mountBody()
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.copyDiff))
    expect(host.textContent).toContain(zh.copyUnavailable)
  })

  it('reports a clipboard that refuses the write', async () => {
    stubClipboard('refused')
    const { host, root } = await mountBody()
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.copyDiff))
    expect(host.textContent).toContain(`${zh.copyFailed}denied`)
  })

  it('reports a clipboard failure that is not an Error as its own text', async () => {
    stubClipboard('throws-text')
    const { host, root } = await mountBody()
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.copyDiff))
    expect(host.textContent).toContain('plain clipboard failure')
  })

  it('copies nothing when there is no difference to copy', async () => {
    const clipboard = stubClipboard()
    const { host, root } = await mountBody()
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await type(host, SOURCE)
    await click(button(host, zh.copyDiff))
    expect(clipboard.written).toEqual([])
    expect(host.textContent).not.toContain(zh.diffCopied)
  })
})

describe('notes on a change', () => {
  it('carries a note into the message the session receives', async () => {
    const stub = stubSessions()
    const { host, root } = await mountBody({ sessions: stub.sessions, sessionId: 's1' })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.diffMode))
    await noteOn(host, '这里先别改，等接口定了')
    await click(button(host, zh.sendEdit))
    const text = stub.prompts[0]?.[0]?.text ?? ''
    expect(text).toContain('说明 1 条')
    expect(text).toContain('我的说明：')
    expect(text).toContain('1. 第 1 行（@@ -1,3 +1,3 @@）：这里先别改，等接口定了')
  })

  it('drops the notes when the edit is discarded', async () => {
    const stub = stubSessions()
    const { host, root } = await mountBody({ sessions: stub.sessions, sessionId: 's1' })
    mounted = root
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.diffMode))
    await noteOn(host, '不要了')
    await click(button(host, zh.discardEdit))
    await type(host, 'title\n\nchanged body\n')
    await click(button(host, zh.sendEdit))
    expect(stub.prompts[0]?.[0]?.text ?? '').not.toContain('我的说明')
  })
})
