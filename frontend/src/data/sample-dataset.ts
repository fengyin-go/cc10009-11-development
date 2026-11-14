import type { SampleRow } from './validation-types'

// 订单支付抽样表：列名为 amount_cents 与 phone_e164，rowNo 为源表原行号。
// 采样比例 80%（每 5 行抽 4 行，跳过 5 的倍数行），源表 500 行，
// 每个校验窗口覆盖 250 源行、抽样 200 行。
// 窗口一（源行 1–250）内置 7 行金额越界 + 3 行手机号长度错误，共 10 行异常；
// 窗口二（源行 251–500）有 2 行金额落在旧口径之外、新口径之内，用于演示口径版本切换。
export const SAMPLE_DATASET = 'order_payment_sample'
export const SOURCE_TOTAL_ROWS = 500
export const WINDOW_SOURCE_ROWS = 250
export const SAMPLES_PER_WINDOW = 200

/** 采样比例：每 5 行抽 4 行（跳过 5 的倍数行），抽样行保留源表原行号。 */
export function isSampled(rowNo: number): boolean {
  return rowNo % 5 !== 0
}

/** 金额越界（v1 口径 1–1000000 分）的原行号与原值。 */
const AMOUNT_OVERRIDES: Record<number, number> = {
  17: 9_999_999,
  33: 0,
  88: -12_345,
  121: 12_000_000,
  159: 88_000_000,
  187: 0,
  204: 7_500_000,
  // 窗口二：超出 v1 上限、但在 v2 口径（上限 5_000_000）之内
  262: 2_000_000,
  318: 3_500_000,
}

/** 手机号长度错误（口径：含 '+' 共 9–16 位）的原行号与原值。 */
const PHONE_OVERRIDES: Record<number, string> = {
  43: '+8613800138000123', // 17 位，超出上限
  102: '+86123', // 6 位，不足下限
  176: '+86138001380009999', // 18 位，超出上限
}

/** 确定性散列：同一行号永远生成同一行数据，刷新、重跑都一致。 */
function hash32(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0
  return (x ^ (x >>> 15)) >>> 0
}

export function sampleRowAt(rowNo: number): SampleRow {
  const amount =
    AMOUNT_OVERRIDES[rowNo] ?? 100 + (hash32(rowNo) % 899_900) // 100–999_999 分，落在口径内
  const phone =
    PHONE_OVERRIDES[rowNo] ?? `+8613${String(10_000_000 + (hash32(rowNo * 7 + 1) % 89_999_999))}`
  return { rowNo, amount_cents: amount, phone_e164: phone }
}

/** 取源行区间 [fromSource, toSource] 内被抽中的样本行（保留原行号）。 */
export function sampleWindow(fromSource: number, toSource: number): SampleRow[] {
  const rows: SampleRow[] = []
  for (let rowNo = fromSource; rowNo <= toSource; rowNo += 1) {
    if (isSampled(rowNo)) {
      rows.push(sampleRowAt(rowNo))
    }
  }
  return rows
}

/** 窗口数据指纹：并发/重复提交时据此识别「同一数据」。 */
export function windowFingerprint(rows: SampleRow[]): string {
  let h = 5381
  for (const row of rows) {
    const s = `${row.rowNo}|${row.amount_cents}|${row.phone_e164};`
    for (let i = 0; i < s.length; i += 1) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
    }
  }
  return h.toString(36)
}
