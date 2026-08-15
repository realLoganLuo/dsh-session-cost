/** Label helpers: pure display mapping over pricing and projection vocabulary. */

import { describe, expect, it } from 'vitest'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { dominantModel, modelLabel, periodLabel, pricingModelOf, versionLabel } from '../src/client/labels.ts'
import type { CostKey } from '../src/client/locales.ts'
import { en } from '../src/client/locales.ts'

const t = ((key: CostKey, params?: Record<string, string | number>): string => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}) as Translate<CostKey>

describe('modelLabel', () => {
  it('maps official model ids to short labels', () => {
    expect(modelLabel('deepseek-v4-flash')).toBe('Flash')
    expect(modelLabel('deepseek-v4-pro')).toBe('Pro')
  })
  it('renders unknown models verbatim', () => {
    expect(modelLabel('deepseek-v3')).toBe('deepseek-v3')
  })
})

describe('periodLabel', () => {
  it('labels all three tariff selections', () => {
    expect(periodLabel(t, 'peak')).toBe('peak')
    expect(periodLabel(t, 'standard')).toBe('off-peak')
    expect(periodLabel(t, null)).toBe('current')
  })
})

describe('versionLabel', () => {
  it('labels known pre-boundary and post-boundary ids by their date', () => {
    expect(versionLabel('deepseek-pre-2026-08-17', t)).toBe('before 08/17')
    expect(versionLabel('deepseek-2026-08-17', t)).toBe('from 08/17')
  })
  it('renders unknown version ids verbatim', () => {
    expect(versionLabel('custom-card-v1', t)).toBe('custom-card-v1')
  })
})

describe('dominantModel', () => {
  it('returns the model with the most requests', () => {
    expect(dominantModel({
      a: { requests: 1, cost: 1, inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0 },
      b: { requests: 3, cost: 1, inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0 },
    })).toBe('b')
  })
  it('keeps the first model on a tie', () => {
    expect(dominantModel({
      a: { requests: 1, cost: 1, inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0 },
      b: { requests: 1, cost: 1, inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0 },
    })).toBe('a')
  })
  it('returns null with no priced requests', () => {
    expect(dominantModel({})).toBeNull()
  })
})

describe('pricingModelOf', () => {
  it('accepts official models and rejects others', () => {
    expect(pricingModelOf('deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(pricingModelOf('deepseek-v3')).toBeNull()
    expect(pricingModelOf(null)).toBeNull()
  })
})
