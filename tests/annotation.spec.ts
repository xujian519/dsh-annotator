/** The stored annotation document: validation, sidecar round trip, and the model-facing summary. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AnnotationDocument, AnnotationMark, MarkKind } from '../src/shared/annotation'
import {
  ANNOTATION_VERSION,
  ANNOTATION_VERSION_V2,
  describeFigureScope,
  describeMark,
  describeMarks,
  pageFileSuffix,
} from '../src/shared/annotation'
import { readAnnotation, readAnnotationDocument, writeAnnotation } from '../src/host/store'
import { buildAnnotationMessage } from '../src/client/session'
import { defined } from './dom'

const document_: AnnotationDocument = {
  version: ANNOTATION_VERSION,
  figure: {
    address: 'dsh-resource://file/session/s1/fig1.svg',
    path: '/w/fig1.svg',
    mediaType: 'image/svg+xml',
    width: 400,
    height: 300,
    sha256: 'a'.repeat(64),
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  marks: [
    {
      id: 'm1',
      kind: 'arrow',
      color: '#e03131',
      points: [[300, 225], [100, 66]],
      text: '这个标号应指向滑套 34',
      anchor: { tag: 'g', title: '102', id: 'node102', text: '导柱', bbox: [40, 40, 120, 60] },
    },
    { id: 'm2', kind: 'pen', color: '#1971c2', points: [[1, 2], [3, 4], [5, 6]] },
    { id: 'm3', kind: 'ellipse', color: '#f08c00', points: [[10, 20], [30, 40]], text: '轮廓多余' },
    { id: 'm4', kind: 'rect', color: '#2f9e44', points: [[5, 5], [50, 60]] },
    { id: 'm5', kind: 'text', color: '#e03131', points: [[200, 200]], text: '图号应在正下方' },
  ],
  summary: '五处问题',
}

describe('document validation', () => {
  it('accepts a document this plugin wrote', () => {
    const parsed = readAnnotationDocument(JSON.parse(JSON.stringify(document_)) as unknown)
    expect(parsed.marks).toHaveLength(5)
    expect(parsed.marks[0]?.anchor?.title).toBe('102')
  })

  it('rejects a wrong version, a missing figure field, and an unknown mark kind', () => {
    const wrongVersion = { ...document_, version: 2 }
    expect(() => readAnnotationDocument(wrongVersion)).toThrow(/version/)
    const missingSha = { ...document_, figure: { ...document_.figure, sha256: undefined } }
    expect(() => readAnnotationDocument(missingSha)).toThrow(/sha256/)
    const badKind = { ...document_, marks: [{ id: 'x', kind: 'stamp', color: '#000', points: [[0, 0]] }] }
    expect(() => readAnnotationDocument(badKind)).toThrow(/unknown kind/)
  })

  it('rejects a mark without coordinates and an anchor without a box', () => {
    expect(() => readAnnotationDocument({ ...document_, marks: [{ id: 'x', kind: 'pen', color: '#000', points: [] }] }))
      .toThrow(/coordinate pair/)
    expect(() => readAnnotationDocument({
      ...document_,
      marks: [{ id: 'x', kind: 'pen', color: '#000', points: [[0, 0]], anchor: { tag: 'g' } }],
    })).toThrow(/bbox/)
  })

  it('rejects a body that is not a document at all', () => {
    for (const value of [null, 'text', 7, true]) expect(() => readAnnotationDocument(value)).toThrow(/must be an object/)
    // An array is an object, so it reaches the version check instead.
    expect(() => readAnnotationDocument([])).toThrow(/version/)
  })

  it('rejects a document with no figure, no marks array, or a non-numeric extent', () => {
    expect(() => readAnnotationDocument({ version: ANNOTATION_VERSION })).toThrow(/needs a figure/)
    expect(() => readAnnotationDocument({ ...document_, marks: 'none' })).toThrow(/marks array/)
    expect(() => readAnnotationDocument({
      ...document_,
      figure: { ...document_.figure, width: 'wide' },
    })).toThrow(/numeric width/)
    expect(() => readAnnotationDocument({
      ...document_,
      figure: { ...document_.figure, height: Number.NaN },
    })).toThrow(/numeric height/)
  })

  it('rejects a malformed mark field by field', () => {
    const withMark = (mark: unknown): unknown => ({ ...document_, marks: [mark] })
    expect(() => readAnnotationDocument(withMark('mark'))).toThrow(/must be an object/)
    expect(() => readAnnotationDocument(withMark({ kind: 'pen', color: '#000', points: [[0, 0]] }))).toThrow(/needs an id/)
    expect(() => readAnnotationDocument(withMark({ id: '', kind: 'pen', color: '#000', points: [[0, 0]] }))).toThrow(/needs an id/)
    expect(() => readAnnotationDocument(withMark({ id: 'x', kind: 'pen', points: [[0, 0]] }))).toThrow(/needs a color/)
    expect(() => readAnnotationDocument(withMark({ id: 'x', kind: 'pen', color: '#000', points: 'none' }))).toThrow(/coordinate pair/)
    expect(() => readAnnotationDocument(withMark({ id: 'x', kind: 'pen', color: '#000', points: [['a', 'b']] })))
      .toThrow(/coordinate pair/)
  })

  it('rejects a malformed anchor field by field', () => {
    const withAnchor = (anchor: unknown): unknown => ({
      ...document_,
      marks: [{ id: 'x', kind: 'pen', color: '#000', points: [[0, 0]], anchor }],
    })
    expect(() => readAnnotationDocument(withAnchor('anchor'))).toThrow(/anchor must be an object/)
    expect(() => readAnnotationDocument(withAnchor({ bbox: [0, 0, 1, 1] }))).toThrow(/needs a tag/)
  })

  it('keeps an anchor that names itself by nothing but its tag', () => {
    const parsed = readAnnotationDocument({
      ...document_,
      marks: [{ id: 'x', kind: 'pen', color: '#000', points: [[0, 0]], anchor: { tag: 'g', bbox: [0, 0, 1, 1] } }],
    })
    expect(defined(parsed.marks[0]).anchor).toEqual({ tag: 'g', bbox: [0, 0, 1, 1] })
  })

  it('fills the timestamps a partial document omits and drops an empty summary', () => {
    const partial = { ...document_, createdAt: undefined, updatedAt: undefined, summary: '' }
    const parsed = readAnnotationDocument(partial)
    expect(parsed.summary).toBeUndefined()
    expect(Number.isNaN(Date.parse(parsed.createdAt))).toBe(false)
    expect(parsed.createdAt).toBe(parsed.updatedAt)
  })

  it('keeps the first-created timestamp when only the update time is missing', () => {
    const parsed = readAnnotationDocument({ ...document_, updatedAt: undefined })
    expect(parsed.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(Number.isNaN(Date.parse(parsed.updatedAt))).toBe(false)
  })
})

describe('sidecar round trip', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-annotator-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('writes both files next to the figure and reads the marks back', async () => {
    const figure = join(directory, 'fig1.svg')
    await writeFile(figure, '<svg/>')
    const saved = await writeAnnotation(figure, document_, new Uint8Array([1, 2, 3]))
    expect(saved.wroteImage).toBe(true)
    expect(saved.paths.annotation).toBe(join(directory, 'fig1.svg.annot.json'))
    expect(await readFile(saved.paths.annotatedImage)).toEqual(Buffer.from([1, 2, 3]))
    expect((await readAnnotation(figure))?.summary).toBe('五处问题')
  })

  it('writes no image when the browser exported none', async () => {
    const figure = join(directory, 'fig1.svg')
    await writeFile(figure, '<svg/>')
    const saved = await writeAnnotation(figure, document_)
    expect(saved.wroteImage).toBe(false)
    await expect(readFile(saved.paths.annotatedImage)).rejects.toThrow()
  })

  it('answers null for a missing and for an unreadable sidecar', async () => {
    const figure = join(directory, 'fig2.svg')
    await writeFile(figure, '<svg/>')
    expect(await readAnnotation(figure)).toBeNull()
    await writeFile(join(directory, 'fig2.svg.annot.json'), '{ not json')
    expect(await readAnnotation(figure)).toBeNull()
  })

  it('ignores a sidecar too large to be one this plugin wrote', async () => {
    const figure = join(directory, 'fig3.svg')
    await writeFile(figure, '<svg/>')
    await writeFile(join(directory, 'fig3.svg.annot.json'), `{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`)
    expect(await readAnnotation(figure)).toBeNull()
  })
})

describe('a sidecar written beside one figure in a shared workbench', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-annotator-shared-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  /** A v2 document: the shape the sibling annotator writes into the same workbench. */
  const v2Document = (figurePath: string): unknown => ({
    version: ANNOTATION_VERSION_V2,
    target: {
      kind: 'figure-svg',
      path: figurePath,
      relativePath: 'figures/fig9.svg',
      mediaType: 'image/svg+xml',
      width: 400,
      height: 300,
      sha256: 'd'.repeat(64),
    },
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    marks: [{
      id: 's1',
      kind: 'arrow',
      color: '#e03131',
      points: [[300, 225], [100, 66]],
      text: '这个标号应指向滑套 34',
      targetFingerprint: `sha256:${'d'.repeat(64)}`,
      anchor: { tag: 'g', title: '102', id: 'node102', nodeId: '102', ref: '34', text: '导柱', bbox: [40, 40, 120, 60] },
    }],
    summary: 'v2 总体说明',
  })

  it('reads a v2 document back in its own shape', async () => {
    const figure = join(directory, 'fig9.svg')
    await writeFile(figure, '<svg/>')
    await writeFile(join(directory, 'fig9.svg.annot.json'), JSON.stringify(v2Document(figure)))
    const stored = defined(await readAnnotation(figure))
    expect(stored.figure.path).toBe(figure)
    expect(stored.figure.sha256).toBe('d'.repeat(64))
    expect(stored.summary).toBe('v2 总体说明')
    expect(stored.marks).toHaveLength(1)
    expect(defined(stored.marks[0]).text).toBe('这个标号应指向滑套 34')
    // The figure's path stands in for the address v2 does not carry, and the fields
    // this plugin does not model are dropped rather than carried along as noise.
    expect(stored.figure.address).toBe(figure)
    expect(defined(stored.marks[0]).anchor)
      .toEqual({ tag: 'g', title: '102', id: 'node102', text: '导柱', bbox: [40, 40, 120, 60] })
  })

  it('reads the marks file earlier versions named after the base name alone', async () => {
    const figure = join(directory, 'fig10.svg')
    await writeFile(figure, '<svg/>')
    const forFigure = { ...document_, figure: { ...document_.figure, path: figure } }
    await writeFile(join(directory, 'fig10.annot.json'), JSON.stringify(forFigure))
    expect((await readAnnotation(figure))?.summary).toBe('五处问题')
  })

  it('prefers the current name when both names hold a document', async () => {
    const figure = join(directory, 'fig11.svg')
    await writeFile(figure, '<svg/>')
    const forFigure = { ...document_, figure: { ...document_.figure, path: figure } }
    await writeFile(join(directory, 'fig11.svg.annot.json'), JSON.stringify({ ...forFigure, summary: '当前名' }))
    await writeFile(join(directory, 'fig11.annot.json'), JSON.stringify({ ...forFigure, summary: '旧名' }))
    expect((await readAnnotation(figure))?.summary).toBe('当前名')
  })

  it('refuses a legacy sidecar that belongs to a figure of the same base name', async () => {
    const svg = join(directory, 'fig12.svg')
    const png = join(directory, 'fig12.png')
    await writeFile(svg, '<svg/>')
    await writeFile(png, 'png')
    // One legacy name, two figures: the document itself says which one it annotates.
    await writeFile(
      join(directory, 'fig12.annot.json'),
      JSON.stringify({ ...document_, figure: { ...document_.figure, path: png } }),
    )
    expect(await readAnnotation(svg)).toBeNull()
    expect((await readAnnotation(png))?.summary).toBe('五处问题')
  })

  it('answers null for a document it cannot recognize', async () => {
    const figure = join(directory, 'fig13.svg')
    await writeFile(figure, '<svg/>')
    const sidecar = join(directory, 'fig13.svg.annot.json')
    const bodies = [
      JSON.stringify({ version: 9 }),
      JSON.stringify(7),
      JSON.stringify(null),
      JSON.stringify({ version: ANNOTATION_VERSION_V2, target: 'figure' }),
      JSON.stringify({ version: ANNOTATION_VERSION_V2, target: null }),
    ]
    for (const body of bodies) {
      await writeFile(sidecar, body)
      expect(await readAnnotation(figure)).toBeNull()
    }
  })
})

describe('model-facing summary', () => {
  it('describes every mark kind with its geometry and note', () => {
    expect(describeMark(defined(document_.marks[0]), 0, 'zh'))
      .toBe('① 箭头 (300,225) → (100,66)（元素标题「102」，id=node102，元素文字「导柱」）：这个标号应指向滑套 34')
    expect(describeMark(defined(document_.marks[1]), 1, 'zh')).toBe('② 手绘线（3 点）：（未写说明）')
    expect(describeMark(defined(document_.marks[4]), 4, 'zh')).toBe('⑤ 文字 位于 (200,200)：图号应在正下方')
    expect(describeMarks(document_, 'en')[2]).toContain('ellipse (10,20)-(30,40)')
  })

  it('numbers past ten without inventing symbols', () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      id: `m${index}`, kind: 'text' as const, color: '#000', points: [[index, index]] as const,
    }))
    expect(describeMark(defined(many[10]), 10, 'zh').startsWith('11.')).toBe(true)
  })

  it('builds the message the session receives', () => {
    const message = buildAnnotationMessage(document_, {
      annotationPath: '/w/fig1.annot.json',
      annotatedImagePath: '/w/fig1.annotated.png',
    }, 'zh')
    expect(message).toContain('【附图标注】/w/fig1.svg')
    expect(message).toContain('标注 5 处')
    expect(message).toContain('标注文件：/w/fig1.annot.json')
    expect(message).toContain('标注图：/w/fig1.annotated.png')
    expect(message).toContain('我的总体说明：五处问题')
    expect(message.trimEnd().endsWith('改完后逐条回应。')).toBe(true)
  })

  it('omits the image line when no review image was written', () => {
    const message = buildAnnotationMessage(document_, { annotationPath: '/w/fig1.annot.json', annotatedImagePath: null }, 'en')
    expect(message).not.toContain('annotated image')
    expect(message).toContain('annotation file: /w/fig1.annot.json')
  })

  it('omits the overall note when the user wrote none', () => {
    const bare: AnnotationDocument = { ...document_ }
    delete (bare as { summary?: string }).summary
    const message = buildAnnotationMessage(bare, { annotationPath: '/w/a.annot.json', annotatedImagePath: null }, 'zh')
    expect(message).not.toContain('我的总体说明')
  })

  it('names a shape without geometry when the mark carries too few points', () => {
    // The wire format only requires one point, so a half-drawn shape is a state
    // the summary has to survive rather than a caller error.
    const one = (kind: MarkKind): AnnotationMark => ({ id: 'b', kind, color: '#000', points: [[1, 1]] })
    const none = (kind: MarkKind): AnnotationMark => ({ id: 'b', kind, color: '#000', points: [] })
    expect(describeMark(one('arrow'), 0, 'zh')).toBe('① 箭头：（未写说明）')
    expect(describeMark(one('rect'), 0, 'zh')).toBe('① 矩形：（未写说明）')
    expect(describeMark(one('ellipse'), 0, 'en')).toBe('① ellipse: (no note)')
    expect(describeMark(none('arrow'), 0, 'en')).toBe('① arrow: (no note)')
    expect(describeMark(none('rect'), 0, 'en')).toBe('① rectangle: (no note)')
    expect(describeMark(none('ellipse'), 0, 'zh')).toBe('① 椭圆：（未写说明）')
    expect(describeMark(none('text'), 0, 'zh')).toBe('① 文字：（未写说明）')
    expect(describeMark(none('text'), 0, 'en')).toBe('① text: (no note)')
  })

  it('names an anchor by whatever it knows: title, id, text, or just the tag', () => {
    const withAnchor = (anchor: AnnotationMark['anchor']): string =>
      describeMark({ id: 'a', kind: 'rect', color: '#000', points: [[0, 0], [1, 1]], ...(anchor === undefined ? {} : { anchor }) }, 0, 'zh')
    expect(withAnchor({ tag: 'g', bbox: [0, 0, 1, 1] })).toContain('（<g>）')
    expect(withAnchor({ tag: 'g', id: 'n1', bbox: [0, 0, 1, 1] })).toContain('（id=n1）')
    expect(withAnchor({ tag: 'text', text: '导柱', bbox: [0, 0, 1, 1] })).toContain('（元素文字「导柱」）')
    expect(withAnchor({ tag: 'g', title: '102', bbox: [0, 0, 1, 1] })).toContain('（元素标题「102」）')
    expect(withAnchor(undefined)).toBe('① 矩形 (0,0)-(1,1)：（未写说明）')
  })
})

describe('paged documents', () => {
  const page = { ...document_.figure, mediaType: 'application/pdf', path: '/w/report.pdf' }

  it('names one page inside the sidecar file name', () => {
    expect(pageFileSuffix(undefined)).toBe('')
    expect(pageFileSuffix(3)).toBe('.p3')
  })

  it('describes which page the marks belong to, with and without a total', () => {
    expect(describeFigureScope(document_.figure, 'zh')).toBe('')
    expect(describeFigureScope({ ...page, page: 2 }, 'zh')).toBe('第 2 页')
    expect(describeFigureScope({ ...page, page: 2 }, 'en')).toBe('page 2')
    expect(describeFigureScope({ ...page, page: 2, pageCount: 7 }, 'zh')).toBe('第 2 页/共 7 页')
    expect(describeFigureScope({ ...page, page: 2, pageCount: 7 }, 'en')).toBe('page 2 of 7')
  })

  it('keeps the page fields a document was written with', () => {
    const parsed = readAnnotationDocument({ ...document_, figure: { ...page, page: 3, pageCount: 9 } })
    expect(parsed.figure.page).toBe(3)
    expect(parsed.figure.pageCount).toBe(9)
    // A whole-figure document stays exactly as it was: no page fields at all.
    expect(readAnnotationDocument(JSON.parse(JSON.stringify(document_)) as unknown).figure.page).toBeUndefined()
  })

  it('rejects a page that is not a positive integer, or beyond the document', () => {
    for (const value of [0, -1, 1.5, '3', null]) {
      expect(() => readAnnotationDocument({ ...document_, figure: { ...page, page: value } })).toThrow(/page must be a positive integer/)
    }
    expect(() => readAnnotationDocument({ ...document_, figure: { ...page, pageCount: 0 } })).toThrow(/pageCount must be a positive integer/)
    expect(() => readAnnotationDocument({ ...document_, figure: { ...page, page: 5, pageCount: 3 } })).toThrow(/outside its 3 pages/)
  })

  it('round-trips one page through its own sidecar file, beside the whole figure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-annotator-page-'))
    try {
      const figure = join(directory, 'report.pdf')
      await writeFile(figure, '%PDF-1.7')
      const pageDocument: AnnotationDocument = {
        ...document_,
        figure: { ...page, path: figure, sha256: 'c'.repeat(64), width: 595, height: 842, page: 2, pageCount: 4 },
        marks: [{ id: 'p1', kind: 'rect', color: '#1971c2', points: [[10, 20], [60, 90]] }],
      }
      const written = await writeAnnotation(figure, pageDocument)
      expect(written.paths.annotation).toBe(join(directory, 'report.pdf.p2.annot.json'))
      expect(await readAnnotation(figure, 2)).toMatchObject({
        figure: { page: 2, pageCount: 4, width: 595, height: 842 },
        marks: [{ id: 'p1' }],
      })
      // The page's sidecar is not the whole figure's: the two never collide.
      expect(await readAnnotation(figure)).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
