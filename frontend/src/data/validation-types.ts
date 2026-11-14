/** 结果校验批次引擎的类型：规则口径版本、校验批次、样例证据、落盘清单与额度台账。 */

/** 判定口径：金额区间（分）与手机号长度区间（含 '+'）。 */
export type JudgmentSpec = {
  amountMin: number
  amountMax: number
  phoneMinLength: number
  phoneMaxLength: number
}

/** 适用范围：抽样表、源行边界与采样比例。 */
export type RuleScope = {
  dataset: string
  sourceFrom: number
  sourceTo: number
  windowSourceRows: number
  sampleRatioLabel: string
}

/** 规则口径版本：口径变化生成新版本，只对生效起始样本之后的样本使用新判定。 */
export type RuleVersion = {
  version: number
  effectiveFromSample: number
  judgment: JudgmentSpec
  anomalyThreshold: number
  blockLevel: string
  createdAt: string
}

export type ValidationRule = {
  ruleNo: string
  name: string
  target: string
  checkType: string
  expression: string
  scope: RuleScope
  versions: RuleVersion[]
  currentVersion: number
}

/** 抽样表行：列名固定为 amount_cents 与 phone_e164，rowNo 为原行号。 */
export type SampleRow = {
  rowNo: number
  amount_cents: number
  phone_e164: string
}

/** 单行判定结果：记录判定所用口径版本，可复核。 */
export type SampleVerdict = SampleRow & {
  ruleVersion: number
  violations: string[]
  abnormal: boolean
}

export type BatchStatus = '运行中' | '已完成' | '已阻断' | '已中断'

/** 校验批次：范围边界与判定口径以快照保存，旧证据保留原范围。 */
export type ValidationBatch = {
  batchNo: string
  idempotencyKey: string
  ruleNo: string
  ruleVersion: number
  dataset: string
  /** 范围边界（源行号）：windowFrom–windowTo，按采样比例抽出 totalSamples 行。 */
  windowFrom: number
  windowTo: number
  sampleRatioLabel: string
  judgment: JudgmentSpec
  anomalyThreshold: number
  blockLevel: string
  status: BatchStatus
  totalSamples: number
  processedSamples: number
  nextSampleIndex: number
  anomalyCount: number
  amountViolations: number
  phoneViolations: number
  verdicts: SampleVerdict[]
  evidence: SampleVerdict[]
  blockedPersist: boolean
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

export type ManifestStatus = '待落盘' | '已落盘' | '已阻断'

/** 落盘清单：各入口共享，阻断结果同步到这里。 */
export type PersistManifestEntry = {
  manifestNo: string
  dataset: string
  windowLabel: string
  batchNo: string
  ruleNo: string
  status: ManifestStatus
  blockReason: string | null
  anomalyCount: number
  evidenceCount: number
  updatedAt: string
}

export type ValidationState = {
  rules: ValidationRule[]
  batches: ValidationBatch[]
  manifest: PersistManifestEntry[]
  quotaTotal: number
  /** 批次号 -> 已扣减样本数；按批次记账，重复提交不重复扣减。 */
  quotaLedger: Record<string, number>
  batchSeq: number
  manifestSeq: number
}
