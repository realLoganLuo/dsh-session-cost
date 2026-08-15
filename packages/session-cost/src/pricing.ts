// Versioned per-request cost accounting for DeepSeek sessions: a rate-card
// engine that prices one request from its model, its billing instant, and the
// official tariff version in force at that instant. Pure functions shared by
// the node half (costStats projection, ledger) and the browser half (stats
// row, dashboard), so the math is unit-testable without a browser.

/**
 * Price per million tokens, in CNY. `inputMiss` covers DeepSeek's documented
 * prompt-cache miss tokens, `inputHit` covers prompt-cache hits, and `output`
 * covers generated tokens (reasoning tokens bill as output).
 */
export interface PricingRates {
  /** Input · cache miss (CNY per 1M tokens). */
  inputMiss: number
  /** Input · cache hit (CNY per 1M tokens). */
  inputHit: number
  /** Output (CNY per 1M tokens). */
  output: number
}

/** DeepSeek models whose official CNY prices are published by the API docs. */
export type DeepSeekPricingModel = 'deepseek-v4-flash' | 'deepseek-v4-pro'

/** Half-open Beijing-hour window `[startHour, endHour)`, hours in 0-23. */
export interface PeakWindow {
  startHour: number
  endHour: number
}

interface RateCardVersionBase {
  /**
   * Stable id recorded on every priced row so a ledger can name the tariff
   * that produced a cost, even after later versions take effect.
   */
  id: string
  /**
   * First instant this version applies (epoch ms). The last version whose
   * `effectiveFrom` is not after the billing instant wins; a version with
   * `effectiveFrom: 0` covers any earlier instant.
   */
  effectiveFrom: number
  /** Rates applied outside peak windows. */
  standard: Readonly<Record<DeepSeekPricingModel, PricingRates>>
}

/**
 * A rate-card version without a peak split: one card for every hour.
 * `peakWindows` and `peak` are structurally absent so pricing can never
 * silently apply a standard card inside a window that has no peak card.
 */
export interface FlatRateCardVersion extends RateCardVersionBase {
  peakWindows?: undefined
  peak?: undefined
}

/** A rate-card version with Beijing peak windows and a distinct peak card. */
export interface SplitRateCardVersion extends RateCardVersionBase {
  /** Peak billing windows as half-open Beijing-hour intervals (`[startHour, endHour)`). */
  peakWindows: readonly PeakWindow[]
  /** Rates applied inside the peak windows. */
  peak: Readonly<Record<DeepSeekPricingModel, PricingRates>>
}

/** One official tariff version, effective from an instant and never revoked. */
export type RateCardVersion = FlatRateCardVersion | SplitRateCardVersion

/** Beijing timezone offset used by the official peak windows, in minutes. */
export const DEEPSEEK_BEIJING_OFFSET_MINUTES = 8 * 60

/**
 * Calendar day key for a billing instant, `YYYY-MM-DD` in the offset calendar.
 * @param timeMs - Billing instant (epoch ms).
 * @param offsetMinutes - Minutes east of UTC used for the calendar.
 * @returns the local date key.
 */
export function dayKeyOf(
  timeMs: number,
  offsetMinutes: number = DEEPSEEK_BEIJING_OFFSET_MINUTES,
): string {
  return new Date(timeMs + offsetMinutes * 60_000).toISOString().slice(0, 10)
}

/**
 * Official DeepSeek CNY rate card, versioned by effective date.
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * Version `deepseek-2026-08-17` applies from Beijing 2026-08-17 00:00
 * (2026-08-16T16:00:00Z) with peak windows `[09:00, 12:00)` and
 * `[14:00, 18:00)` Beijing time.
 */
export const OFFICIAL_RATE_CARD: readonly RateCardVersion[] = [
  {
    id: 'deepseek-pre-2026-08-17',
    effectiveFrom: 0,
    standard: {
      'deepseek-v4-flash': { inputMiss: 1, inputHit: 0.02, output: 2 },
      'deepseek-v4-pro': { inputMiss: 3, inputHit: 0.025, output: 6 },
    },
  },
  {
    id: 'deepseek-2026-08-17',
    effectiveFrom: Date.parse('2026-08-16T16:00:00.000Z'),
    peakWindows: [
      { startHour: 9, endHour: 12 },
      { startHour: 14, endHour: 18 },
    ],
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

/** Whether a billing instant falls in a peak window. */
export type PricingPeriod = 'peak' | 'standard'

/** The tariff selection for one request: version, period, and rates. */
export interface PricedSelection {
  /** Id of the rate-card version that produced the rates. */
  versionId: string
  /**
   * `'peak'` inside a version's peak window, `'standard'` outside one, and
   * `null` for versions without a peak split.
   */
  period: PricingPeriod | null
  /** The applicable rate card. */
  rates: PricingRates
}

/**
 * Select the tariff version in force at an instant.
 * @param card - Versioned rate card, newest-last; must not be empty.
 * @param timeMs - Billing instant (epoch ms).
 * @returns The last version whose `effectiveFrom` is not after `timeMs`.
 */
export function selectRateVersion(
  card: readonly RateCardVersion[],
  timeMs: number,
): RateCardVersion {
  let selected: RateCardVersion | undefined
  for (const version of card) {
    if (selected === undefined || version.effectiveFrom <= timeMs) selected = version
  }
  if (selected === undefined) throw new Error('selectRateVersion: rate card must not be empty')
  return selected
}

/**
 * Whether a Beijing-time instant falls inside any half-open peak window.
 * @param timeMs - Billing instant (epoch ms).
 * @param peakWindows - Windows to test; empty means never peak.
 * @param offsetMinutes - Minutes east of UTC used for the window calendar.
 * @returns True inside a window.
 */
export function isPeakHour(
  timeMs: number,
  peakWindows: readonly PeakWindow[] | undefined,
  offsetMinutes: number = DEEPSEEK_BEIJING_OFFSET_MINUTES,
): boolean {
  if (peakWindows === undefined || peakWindows.length === 0) return false
  const localHour = new Date(timeMs + offsetMinutes * 60_000).getUTCHours()
  return peakWindows.some(window => localHour >= window.startHour && localHour < window.endHour)
}

/**
 * Price one request from its model and billing instant.
 * @param model - Official DeepSeek API model id.
 * @param timeMs - Request billing instant (epoch ms).
 * @param card - Versioned rate card; defaults to the official table.
 * @param offsetMinutes - Minutes east of UTC used for peak windows.
 * @returns The tariff selection for the request.
 */
export function selectPricing(
  model: DeepSeekPricingModel,
  timeMs: number,
  card: readonly RateCardVersion[] = OFFICIAL_RATE_CARD,
  offsetMinutes: number = DEEPSEEK_BEIJING_OFFSET_MINUTES,
): PricedSelection {
  const version = selectRateVersion(card, timeMs)
  if (version.peakWindows !== undefined && isPeakHour(timeMs, version.peakWindows, offsetMinutes)) {
    return { versionId: version.id, period: 'peak', rates: version.peak[model] }
  }
  return {
    versionId: version.id,
    period: version.peakWindows === undefined ? null : 'standard',
    rates: version.standard[model],
  }
}

/** Bucket-wise token usage, mapped onto DeepSeek's documented billing fields. */
export interface BillableUsage {
  uncachedInputTokens: number
  cacheReadTokens: number
  /** Generic adapters may report this bucket; DeepSeek publishes no separate write price. */
  cacheWriteTokens?: number
  outputTokens: number
}

/**
 * DeepSeek-documented cost from cache-miss input, cache-hit input, and
 * output. A generic cache-write bucket is deliberately excluded because the
 * official DeepSeek schema and price table publish no independent write fee.
 * All amounts are in CNY.
 * @param usage - Provider-reported token buckets.
 * @param rates - Rate card in force for the request.
 * @returns Input, output, and total CNY estimate.
 */
export function computeCost(usage: BillableUsage, rates: PricingRates): { input: number; output: number; total: number } {
  const input = usage.uncachedInputTokens / 1_000_000 * rates.inputMiss
    + usage.cacheReadTokens / 1_000_000 * rates.inputHit
  const output = usage.outputTokens / 1_000_000 * rates.output
  return { input, output, total: input + output }
}

/** Monday-based week key, `YYYY-MM-DD` of the week's Monday in the offset calendar. */
export function weekKeyOf(
  timeMs: number,
  offsetMinutes: number = DEEPSEEK_BEIJING_OFFSET_MINUTES,
): string {
  const local = new Date(timeMs + offsetMinutes * 60_000)
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  return monday.toISOString().slice(0, 10)
}

/** Month key `YYYY-MM` in the offset calendar. */
export function monthKeyOf(
  timeMs: number,
  offsetMinutes: number = DEEPSEEK_BEIJING_OFFSET_MINUTES,
): string {
  const local = new Date(timeMs + offsetMinutes * 60_000)
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Compact CNY display: two decimals under 10, one under 100, integers from 100.
 * @param n - amount in yuan.
 * @returns display string.
 */
export function formatYuan(n: number): string {
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}
