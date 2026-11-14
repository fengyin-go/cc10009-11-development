import { SAMPLE_DATASET, SOURCE_TOTAL_ROWS, WINDOW_SOURCE_ROWS } from './sample-dataset'
import type { ValidationRule, ValidationState } from './validation-types'

// 校验批次引擎的本地持久化：规则口径版本、批次（含断点）、落盘清单、额度台账。
const STORAGE_KEY = 'scraper-config-studio:validation'

const SEED_TIME = '2026-11-14T09:00:00.000Z'

/** VAL-51：结果校验页已保存的校验规则，v1 口径从第 1 行源行起生效。 */
export function seedVal51(): ValidationRule {
  return {
    ruleNo: 'VAL-51',
    name: '订单支付结果抽样校验',
    target: 'order_payment_sample（订单支付抽样表）',
    checkType: '字段范围与长度',
    expression: 'amount_cents BETWEEN 1 AND 1000000；LENGTH(phone_e164) BETWEEN 9 AND 16',
    scope: {
      dataset: SAMPLE_DATASET,
      sourceFrom: 1,
      sourceTo: SOURCE_TOTAL_ROWS,
      windowSourceRows: WINDOW_SOURCE_ROWS,
      sampleRatioLabel: '80%（每 5 行抽 4 行）',
    },
    versions: [
      {
        version: 1,
        effectiveFromSample: 1,
        judgment: { amountMin: 1, amountMax: 1_000_000, phoneMinLength: 9, phoneMaxLength: 16 },
        anomalyThreshold: 5,
        blockLevel: '超过阈值即阻断落盘',
        createdAt: SEED_TIME,
      },
    ],
    currentVersion: 1,
  }
}

function seedState(): ValidationState {
  return {
    rules: [seedVal51()],
    batches: [],
    manifest: [],
    quotaTotal: 1000,
    quotaLedger: {},
    batchSeq: 0,
    manifestSeq: 0,
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 没有 localStorage 的环境（单元测试、SSR）退化为进程内存，接口保持一致。
let memoryBlob: string | null = null

function backend(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage
    }
  } catch {
    // 忽略隐私模式等读取异常
  }
  return null
}

function readRaw(): string | null {
  const store = backend()
  if (store) {
    return store.getItem(STORAGE_KEY)
  }
  return memoryBlob
}

function writeRaw(raw: string): void {
  const store = backend()
  if (store) {
    store.setItem(STORAGE_KEY, raw)
  }
  memoryBlob = raw
}

let cache: ValidationState | null = null

function loadState(): ValidationState {
  const raw = readRaw()
  if (!raw) {
    return seedState()
  }
  try {
    const parsed = JSON.parse(raw) as ValidationState
    // 上次会话（或服务）中断时遗留下来的「运行中」批次，一律标记为「已中断」，
    // 之后从 nextSampleIndex 断点处恢复，不从头重跑。
    for (const batch of parsed.batches) {
      if (batch.status === '运行中') {
        batch.status = '已中断'
        batch.updatedAt = new Date().toISOString()
      }
    }
    return { ...seedState(), ...parsed }
  } catch {
    return seedState()
  }
}

export function getState(): ValidationState {
  if (cache === null) {
    cache = loadState()
    writeRaw(JSON.stringify(cache))
  }
  return cache
}

export function readState(): ValidationState {
  return clone(getState())
}

function notifyChanged(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('validation:changed'))
    }
  } catch {
    // 非浏览器环境忽略
  }
}

/**
 * 原子读改写：fn 同步执行，期间不会交错其它改写，
 * 同一数据 + 同一口径版本的批次只会被创建一次。
 */
export function mutateState<T>(fn: (state: ValidationState) => T): T {
  const state = getState()
  const result = fn(state)
  writeRaw(JSON.stringify(state))
  notifyChanged()
  return result
}

/** 测试/演示用：清空引擎数据，恢复 VAL-51 初始状态。 */
export function resetValidationStore(): ValidationState {
  cache = seedState()
  writeRaw(JSON.stringify(cache))
  notifyChanged()
  return clone(cache)
}

export function validationStorageKey(): string {
  return STORAGE_KEY
}
