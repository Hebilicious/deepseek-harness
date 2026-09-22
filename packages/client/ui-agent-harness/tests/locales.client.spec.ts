/** Locale dictionaries for the new-session harness chip. */

import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('agent-harness copy', () => {
  it('covers every key in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const value of [...Object.values(en), ...Object.values(zh)]) {
      expect(value.trim()).not.toBe('')
    }
  })
})
