import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_RATE_CARD,
  dayKeyOf,
  computeCost,
  formatYuan,
  isPeakHour,
  selectPricing,
  selectRateVersion,
  type BillableUsage,
  type RateCardVersion,
} from '../src/pricing.ts'

/** Instant in Beijing time expressed as UTC: Beijing 2026-08-17 10:00 == 02:00Z. */
const BEIJING_2026_08_17_10_00 = Date.parse('2026-08-17T02:00:00Z')
/** The official peak-version effective instant: Beijing 2026-08-17 00:00. */
const EFFECTIVE_AT = Date.parse('2026-08-16T16:00:00Z')

const PEER_CARD: readonly RateCardVersion[] = [
  {
    id: 'v1',
    effectiveFrom: 0,
    standard: {
      'deepseek-v4-flash': { inputMiss: 1, inputHit: 0.02, output: 2 },
      'deepseek-v4-pro': { inputMiss: 3, inputHit: 0.025, output: 6 },
    },
  },
  {
    id: 'v2',
    effectiveFrom: EFFECTIVE_AT,
    peakWindows: [{ startHour: 9, endHour: 12 }],
    standard: {
      'deepseek-v4-flash': { inputMiss: 1.5, inputHit: 0.05, output: 4.5 },
      'deepseek-v4-pro': { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
    },
    peak: {
      'deepseek-v4-flash': { inputMiss: 3, inputHit: 0.1, output: 9 },
      'deepseek-v4-pro': { inputMiss: 9, inputHit: 0.3, output: 27 },
    },
  },
]

/** Official versions 0 and 1, guarded once: the fixture owns their presence. */
const OFFICIAL_V0 = OFFICIAL_RATE_CARD[0]
const OFFICIAL_V1 = OFFICIAL_RATE_CARD[1]
if (OFFICIAL_V0 === undefined || OFFICIAL_V1 === undefined) {
  throw new Error('pricing fixture: official rate card must carry two versions')
}

describe('isPeakHour', () => {
  it('treats Beijing 09:00-11:59 as peak', () => {
    expect(isPeakHour(Date.parse('2026-08-17T02:00:00Z'), OFFICIAL_V1.peakWindows)).toBe(true)
  })
  it('treats Beijing 14:00-17:59 as peak', () => {
    expect(isPeakHour(Date.parse('2026-08-17T07:30:00Z'), OFFICIAL_V1.peakWindows)).toBe(true)
  })
  it('treats Beijing 12:00-13:59 as off-peak', () => {
    expect(isPeakHour(Date.parse('2026-08-17T05:00:00Z'), OFFICIAL_V1.peakWindows)).toBe(false)
  })
  it('treats Beijing 00:00-08:59 as off-peak', () => {
    expect(isPeakHour(Date.parse('2026-08-17T00:30:00Z'), OFFICIAL_V1.peakWindows)).toBe(false)
  })
  it('treats Beijing 18:00-23:59 as off-peak', () => {
    expect(isPeakHour(Date.parse('2026-08-17T11:00:00Z'), OFFICIAL_V1.peakWindows)).toBe(false)
  })
  it('is never peak for a version without peak windows', () => {
    expect(isPeakHour(BEIJING_2026_08_17_10_00, OFFICIAL_V0.peakWindows)).toBe(false)
  })
  it('honours a custom timezone offset', () => {
    // Beijing (+8) makes 18:00Z the next day's 02:00: outside [09:00, 12:00).
    expect(isPeakHour(Date.parse('2026-08-17T18:00:00Z'), OFFICIAL_V1.peakWindows)).toBe(false)
    // A Tokyo-like offset (+9) makes 00:30Z local 09:30: inside the window.
    expect(isPeakHour(Date.parse('2026-08-17T00:30:00Z'), OFFICIAL_V1.peakWindows, 9 * 60)).toBe(true)
  })
  it('treats Beijing 09:00 exactly as peak and 12:00 exactly as off-peak', () => {
    expect(isPeakHour(Date.parse('2026-08-17T01:00:00Z'), OFFICIAL_V1.peakWindows)).toBe(true)
    expect(isPeakHour(Date.parse('2026-08-17T04:00:00Z'), OFFICIAL_V1.peakWindows)).toBe(false)
  })
  it('treats Beijing 14:00 exactly as peak and 18:00 exactly as off-peak', () => {
    expect(isPeakHour(Date.parse('2026-08-17T06:00:00Z'), OFFICIAL_V1.peakWindows)).toBe(true)
    expect(isPeakHour(Date.parse('2026-08-17T10:00:00Z'), OFFICIAL_V1.peakWindows)).toBe(false)
  })
  it('is never peak for an empty window list', () => {
    expect(isPeakHour(BEIJING_2026_08_17_10_00, [])).toBe(false)
  })
})

describe('dayKeyOf', () => {
  it('maps Beijing midnight to the Beijing calendar day', () => {
    // Beijing 2026-08-17 00:00 == 2026-08-16T16:00Z.
    expect(dayKeyOf(Date.parse('2026-08-16T16:00:00Z'))).toBe('2026-08-17')
  })
  it('keeps late-evening Beijing instants on the same day', () => {
    // Beijing 2026-08-17 23:30 == 2026-08-17T15:30Z.
    expect(dayKeyOf(Date.parse('2026-08-17T15:30:00Z'))).toBe('2026-08-17')
  })
  it('honours a custom offset', () => {
    expect(dayKeyOf(Date.parse('2026-08-16T16:00:00Z'), 0)).toBe('2026-08-16')
  })
})


describe('selectRateVersion', () => {
  it('selects the first version before any effective boundary', () => {
    expect(selectRateVersion(PEER_CARD, EFFECTIVE_AT - 1).id).toBe('v1')
  })
  it('selects the newer version at the exact effective instant', () => {
    expect(selectRateVersion(PEER_CARD, EFFECTIVE_AT).id).toBe('v2')
  })
  it('selects the last version whose boundary has passed', () => {
    expect(selectRateVersion(PEER_CARD, BEIJING_2026_08_17_10_00).id).toBe('v2')
  })
  it('fails loud on an empty card', () => {
    expect(() => selectRateVersion([], 0)).toThrow('rate card must not be empty')
  })
})

describe('selectPricing', () => {
  it('prices pre-boundary requests at the current card without a period', () => {
    const selection = selectPricing('deepseek-v4-flash', EFFECTIVE_AT - 1)
    expect(selection).toEqual({
      versionId: 'deepseek-pre-2026-08-17',
      period: null,
      rates: { inputMiss: 1, inputHit: 0.02, output: 2 },
    })
  })
  it('picks the peak card inside the peak window', () => {
    const selection = selectPricing('deepseek-v4-flash', BEIJING_2026_08_17_10_00)
    expect(selection.period).toBe('peak')
    expect(selection.rates).toEqual({ inputMiss: 3, inputHit: 0.1, output: 9 })
  })
  it('picks the off-peak card outside the peak window', () => {
    const selection = selectPricing('deepseek-v4-flash', Date.parse('2026-08-17T05:00:00Z'))
    expect(selection.period).toBe('standard')
    expect(selection.rates).toEqual({ inputMiss: 1.5, inputHit: 0.05, output: 4.5 })
  })
  it('prices the Pro model on its own card', () => {
    const selection = selectPricing('deepseek-v4-pro', BEIJING_2026_08_17_10_00)
    expect(selection.rates).toEqual({ inputMiss: 9, inputHit: 0.3, output: 27 })
  })
})

describe('computeCost', () => {
  const usage: BillableUsage = {
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 500_000,
    outputTokens: 200_000,
  }
  it('prices miss input, hit input, and output with the given rates', () => {
    const cost = computeCost(usage, { inputMiss: 1, inputHit: 0.02, output: 2 })
    expect(cost.input).toBeCloseTo(1.01, 10)
    expect(cost.output).toBe(0.4)
    expect(cost.total).toBeCloseTo(1.41, 10)
  })
  it('ignores the generic cache-write bucket', () => {
    const withWrites = { ...usage, cacheWriteTokens: 9_000_000 }
    expect(computeCost(withWrites, { inputMiss: 1, inputHit: 0.02, output: 2 }).total)
      .toBeCloseTo(1.41, 10)
  })
  it('is exact at the official peak card', () => {
    const cost = computeCost(usage, { inputMiss: 3, inputHit: 0.1, output: 9 })
    expect(cost).toEqual({ input: 3.05, output: 1.8, total: 4.85 })
  })
  it('treats missing buckets as zero', () => {
    expect(computeCost({ uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, OFFICIAL_V0.standard['deepseek-v4-flash']).total).toBe(0)
  })
})

describe('formatYuan', () => {
  it('keeps two decimals under ten', () => {
    expect(formatYuan(1.41)).toBe('1.41')
  })
  it('keeps one decimal from ten', () => {
    expect(formatYuan(12.34)).toBe('12.3')
  })
  it('rounds integers from one hundred', () => {
    expect(formatYuan(123.45)).toBe('123')
  })
})
