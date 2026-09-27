/** Product copy: the dictionaries, their key parity, and the no-locale-service fallback. */
import { describe, expect, it } from 'vitest'
import { NAMESPACE, en, fallbackTranslate, zh } from '../src/client/locales'

describe('the annotator dictionary', () => {
  it('registers under one namespace', () => {
    expect(NAMESPACE).toBe('annotator')
  })

  it('carries the same keys in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('leaves no copy empty', () => {
    for (const [key, value] of Object.entries({ ...zh, ...en })) expect(value, key).not.toBe('')
  })
})

describe('the fallback translator', () => {
  it('answers English for any English locale tag', () => {
    expect(fallbackTranslate('en', 'title')).toBe(en.title)
    expect(fallbackTranslate('en-GB', 'title')).toBe(en.title)
  })

  it('answers Chinese for Chinese and for anything unrecognized', () => {
    expect(fallbackTranslate('zh', 'title')).toBe(zh.title)
    expect(fallbackTranslate('zh-Hans', 'title')).toBe(zh.title)
    expect(fallbackTranslate('fr', 'title')).toBe(zh.title)
  })

  it('answers the key itself when the dictionary has no such copy', () => {
    expect(fallbackTranslate('zh', 'not-a-key')).toBe('not-a-key')
  })

  it('fills the values a string asks for, and leaves the ones it was not given', () => {
    expect(fallbackTranslate('zh', 'documentScope', { pages: 3, marks: 5 })).toBe('共 3 页 · 5 处批注')
    expect(fallbackTranslate('en', 'documentScope', { pages: 3, marks: 5 })).toBe('3 pages · 5 marks')
    expect(fallbackTranslate('zh', 'documentScope', { pages: 3 })).toBe('共 3 页 · {marks} 处批注')
    expect(fallbackTranslate('zh', 'documentScope')).toBe(zh.documentScope)
  })
})
