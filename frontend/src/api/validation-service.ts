import { sampleWindow, windowFingerprint } from '@/data/sample-dataset'
import { mutateState, readState, resetValidationStore } from '@/data/validation-store'
import type {
  JudgmentSpec,
  ManifestStatus,
  PersistManifestEntry,
  SampleRow,
  SampleVerdict,
  ValidationBatch,
  ValidationRule,
  ValidationState,
} from '@/data/validation-types'

// 结果校验批次引擎：生成批次、分块执行、断点恢复、口径版本、阻断同步落盘清单。
// 页面组件只调用这里，不直接改数据。

export const EVIDENCE_LIMIT = 10
const DEFAULT_CHUNK_SIZE = 50
const DEFAULT_CHUNK_DELAY_MS = 20

export type BatchRunResult = {
  ok: boolean
  created: boolean
  batch: ValidationBatch | null
  message: string
}

export type RunOptions = {
  chunkSize?: number
  chunkDelayMs?: number
  /** 测试/演示用：执行 N 个分块后模拟服务中断。 */
  interruptAfterChunks?: number
}

type RuleVersionShape = ValidationRule['versions'][number]

/** 单行判定：金额区间 + 手机号长度，返回带口径版本的判定结果。 */
export function judgeSample(
  row: SampleRow,
  judgment: JudgmentSpec,
  ruleVersion: number,
): SampleVerdict {
  const violations: string[] = []
  if (row.amount_cents < judgment.amountMin || row.amount_cents > judgment.amountMax) {
    violations.push(
      `amount_cents 越界（口径 ${judgment.amountMin}–${judgment.amountMax}，原值 ${row.amount_cents}）`,
    )
  }
  const phoneLength = row.phone_e164.length
  if (phoneLength < judgment.phoneMinLength || phoneLength > judgment.phoneMaxLength) {
    violations.push(
      `phone_e164 长度错误（口径 ${judgment.phoneMinLength}–${judgment.phoneMaxLength} 位，原值长度 ${phoneLength}）`,
    )
  }
  return { ...row, ruleVersion, violations, abnormal: violations.length > 0 }
}

// ---------- 只读查询 ----------

export function listRules(): ValidationRule[] {
  return readState().rules
}

export function getRule(ruleNo: string): ValidationRule | null {
  return readState().rules.find((rule) => rule.ruleNo === ruleNo) ?? null
}

export function listBatches(ruleNo?: string): ValidationBatch[] {
  const { batches } = readState()
  const matched = ruleNo ? batches.filter((batch) => batch.ruleNo === ruleNo) : batches
  return matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getBatch(batchNo: string): ValidationBatch | null {
  return readState().batches.find((batch) => batch.batchNo === batchNo) ?? null
}

export function listManifest(): PersistManifestEntry[] {
  return readState().manifest
}

export function quotaView(): { total: number; used: number; remaining: number } {
  const state = readState()
  const used = Object.values(state.quotaLedger).reduce((sum, n) => sum + n, 0)
  return { total: state.quotaTotal, used, remaining: state.quotaTotal - used }
}

// ---------- 批次生成（幂等） ----------

type WindowPlan =
  | { kind: 'resume'; batch: ValidationBatch }
  | { kind: 'empty' }
  | { kind: 'new'; windowFrom: number; windowTo: number }

/** 下一个待校验窗口：在途批次（运行中/已中断）直接命中；否则从上次的范围边界之后继续。 */
function planWindow(state: ValidationState, rule: ValidationRule): WindowPlan {
  const own = state.batches.filter((batch) => batch.ruleNo === rule.ruleNo)
  const inFlight = own.find((batch) => batch.status === '运行中' || batch.status === '已中断')
  if (inFlight) {
    return { kind: 'resume', batch: inFlight }
  }
  const coveredTo = own.reduce((max, batch) => Math.max(max, batch.windowTo), 0)
  const windowFrom = Math.max(rule.scope.sourceFrom, coveredTo + 1)
  if (windowFrom > rule.scope.sourceTo) {
    return { kind: 'empty' }
  }
  const windowTo = Math.min(windowFrom + rule.scope.windowSourceRows - 1, rule.scope.sourceTo)
  return { kind: 'new', windowFrom, windowTo }
}

function currentVersion(rule: ValidationRule) {
  const found = rule.versions.find((item) => item.version === rule.currentVersion)
  if (!found) {
    throw new Error(`规则 ${rule.ruleNo} 缺少当前口径版本`)
  }
  return found
}

type GenerateOutcome =
  | { kind: 'batch'; batch: ValidationBatch; created: boolean }
  | { kind: 'empty' }

/**
 * 生成校验批次：幂等键 = 规则 + 口径版本 + 数据窗口指纹。
 * 同一数据同一口径只生成一次；并发/重复提交命中已有批次直接返回。
 */
function generateBatchOnce(state: ValidationState, ruleNo: string): GenerateOutcome {
  const rule = state.rules.find((item) => item.ruleNo === ruleNo)
  if (!rule) {
    throw new Error(`没有找到校验规则 ${ruleNo}`)
  }
  const plan = planWindow(state, rule)
  if (plan.kind === 'empty') {
    return { kind: 'empty' }
  }
  if (plan.kind === 'resume') {
    return { kind: 'batch', batch: plan.batch, created: false }
  }
  const rows = sampleWindow(plan.windowFrom, plan.windowTo)
  const version = currentVersion(rule)
  const idempotencyKey = [
    rule.ruleNo,
    `v${version.version}`,
    rule.scope.dataset,
    `${plan.windowFrom}-${plan.windowTo}`,
    windowFingerprint(rows),
  ].join(':')
  const existing = state.batches.find((batch) => batch.idempotencyKey === idempotencyKey)
  if (existing) {
    return { kind: 'batch', batch: existing, created: false }
  }
  const now = new Date().toISOString()
  state.batchSeq += 1
  const batch: ValidationBatch = {
    batchNo: `${rule.ruleNo}-B${String(state.batchSeq).padStart(4, '0')}`,
    idempotencyKey,
    ruleNo: rule.ruleNo,
    ruleVersion: version.version,
    dataset: rule.scope.dataset,
    windowFrom: plan.windowFrom,
    windowTo: plan.windowTo,
    sampleRatioLabel: rule.scope.sampleRatioLabel,
    judgment: { ...version.judgment },
    anomalyThreshold: version.anomalyThreshold,
    blockLevel: version.blockLevel,
    status: '运行中',
    totalSamples: rows.length,
    processedSamples: 0,
    nextSampleIndex: 0,
    anomalyCount: 0,
    amountViolations: 0,
    phoneViolations: 0,
    verdicts: [],
    evidence: [],
    blockedPersist: false,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  }
  state.batches.push(batch)
  return { kind: 'batch', batch, created: true }
}

// ---------- 批次执行（分块 + 断点） ----------

const runningBatches = new Set<string>()
let interruptRequested = false

/** 请求中断当前执行：当前分块落账后，批次标记为「已中断」，可从下一样本恢复。 */
export function requestInterrupt(): void {
  interruptRequested = true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

type ChunkOutcome = 'finished' | 'interrupted' | 'continue' | 'missing'

/** 处理一个分块并落账（含额度台账与断点），返回执行走向。 */
function processChunk(
  state: ValidationState,
  batchNo: string,
  chunkSize: number,
  stopBeforeChunk: boolean,
): ChunkOutcome {
  const batch = state.batches.find((item) => item.batchNo === batchNo)
  if (!batch) {
    return 'missing'
  }
  if (batch.status === '已中断') {
    // 恢复执行：从断点 nextSampleIndex 继续，已判定的样本与扣减原样保留。
    batch.status = '运行中'
    batch.updatedAt = new Date().toISOString()
    return 'continue'
  }
  if (batch.status !== '运行中') {
    return 'finished'
  }
  if (stopBeforeChunk) {
    batch.status = '已中断'
    batch.updatedAt = new Date().toISOString()
    return 'interrupted'
  }
  const windowRows = sampleWindow(batch.windowFrom, batch.windowTo)
  const rows = windowRows.slice(batch.nextSampleIndex, batch.nextSampleIndex + chunkSize)
  for (const row of rows) {
    const verdict = judgeSample(row, batch.judgment, batch.ruleVersion)
    batch.verdicts.push(verdict)
    if (verdict.abnormal) {
      batch.anomalyCount += 1
      if (verdict.violations.some((text) => text.startsWith('amount_cents'))) {
        batch.amountViolations += 1
      }
      if (verdict.violations.some((text) => text.startsWith('phone_e164'))) {
        batch.phoneViolations += 1
      }
    }
  }
  batch.nextSampleIndex += rows.length
  batch.processedSamples = batch.nextSampleIndex
  // 额度按批次台账记账：同一批次重复提交/恢复都只更新同一条账，不重复扣减。
  state.quotaLedger[batch.batchNo] = batch.processedSamples
  batch.updatedAt = new Date().toISOString()
  if (batch.nextSampleIndex < batch.totalSamples) {
    return 'continue'
  }
  finalizeBatch(state, batch)
  return 'finished'
}

/** 收尾：超阈值即阻断并同步落盘清单；样例证据保留原行号与原值。 */
function finalizeBatch(state: ValidationState, batch: ValidationBatch): void {
  const now = new Date().toISOString()
  batch.evidence = batch.verdicts.filter((verdict) => verdict.abnormal).slice(0, EVIDENCE_LIMIT)
  const blocked = batch.anomalyCount > batch.anomalyThreshold
  batch.status = blocked ? '已阻断' : '已完成'
  batch.blockedPersist = blocked
  batch.finishedAt = now
  batch.updatedAt = now

  const manifestStatus: ManifestStatus = blocked ? '已阻断' : '待落盘'
  const blockReason = blocked
    ? `异常 ${batch.anomalyCount} 行超过阈值 ${batch.anomalyThreshold}（金额越界 ${batch.amountViolations} 行、手机号长度错误 ${batch.phoneViolations} 行），按「${batch.blockLevel}」处理`
    : null
  const existing = state.manifest.find((entry) => entry.batchNo === batch.batchNo)
  if (existing) {
    existing.status = manifestStatus
    existing.blockReason = blockReason
    existing.anomalyCount = batch.anomalyCount
    existing.evidenceCount = batch.evidence.length
    existing.updatedAt = now
    return
  }
  state.manifestSeq += 1
  state.manifest.push({
    manifestNo: `MF-${String(state.manifestSeq).padStart(4, '0')}`,
    dataset: batch.dataset,
    windowLabel: `行 ${batch.windowFrom}–${batch.windowTo}`,
    batchNo: batch.batchNo,
    ruleNo: batch.ruleNo,
    status: manifestStatus,
    blockReason,
    anomalyCount: batch.anomalyCount,
    evidenceCount: batch.evidence.length,
    updatedAt: now,
  })
}

async function runBatchLoop(batchNo: string, options: RunOptions): Promise<BatchRunResult> {
  if (runningBatches.has(batchNo)) {
    return { ok: false, created: false, batch: getBatch(batchNo), message: `批次 ${batchNo} 正在执行中` }
  }
  runningBatches.add(batchNo)
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  const delay = options.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS
  let chunks = 0
  try {
    for (;;) {
      const stopBeforeChunk =
        interruptRequested ||
        (options.interruptAfterChunks !== undefined && chunks >= options.interruptAfterChunks)
      const outcome = mutateState((state) => processChunk(state, batchNo, chunkSize, stopBeforeChunk))
      if (outcome === 'missing') {
        return { ok: false, created: false, batch: null, message: `没有找到批次 ${batchNo}` }
      }
      if (outcome === 'interrupted') {
        interruptRequested = false
        const batch = getBatch(batchNo)
        return {
          ok: true,
          created: false,
          batch,
          message: `批次 ${batchNo} 已中断，已处理 ${batch?.processedSamples ?? 0}/${batch?.totalSamples ?? 0} 行，可从下一样本恢复`,
        }
      }
      if (outcome === 'finished') {
        const batch = getBatch(batchNo)
        if (!batch) {
          return { ok: false, created: false, batch: null, message: `没有找到批次 ${batchNo}` }
        }
        if (batch.status === '已阻断') {
          return {
            ok: true,
            created: false,
            batch,
            message: `批次 ${batch.batchNo} 异常 ${batch.anomalyCount} 行超过阈值 ${batch.anomalyThreshold}，已阻断落盘，样例证据 ${batch.evidence.length} 条`,
          }
        }
        return {
          ok: true,
          created: false,
          batch,
          message: `批次 ${batch.batchNo} 校验完成，异常 ${batch.anomalyCount} 行，未超阈值，可落盘`,
        }
      }
      chunks += 1
      // 分块间让出事件循环：并发提交能命中在途批次，页面也不被长任务卡住。
      await sleep(delay)
    }
  } finally {
    runningBatches.delete(batchNo)
  }
}

// ---------- 跨标签页互斥（浏览器内多入口并发） ----------

type LockLike = { request: (name: string, callback: () => Promise<unknown>) => Promise<unknown> }

function navigatorLocks(): LockLike | null {
  try {
    const nav = globalThis.navigator as (Navigator & { locks?: LockLike }) | undefined
    return nav?.locks ?? null
  } catch {
    return null
  }
}

async function withBatchLock<T>(ruleNo: string, fn: () => Promise<T>): Promise<T> {
  const locks = navigatorLocks()
  if (!locks) {
    return fn()
  }
  return locks.request(`validation-batch:${ruleNo}`, fn) as Promise<T>
}

// ---------- 对外操作 ----------

/**
 * 生成并执行校验批次。
 * 并发/重复提交：同一数据同一口径版本只生成一个批次；
 * 已有中断批次时从断点（下一样本）恢复，不重新生成、不重复扣减。
 */
export async function generateAndRunBatch(
  ruleNo: string,
  options: RunOptions = {},
): Promise<BatchRunResult> {
  return withBatchLock(ruleNo, async () => {
    const outcome = mutateState((state) => generateBatchOnce(state, ruleNo))
    if (outcome.kind === 'empty') {
      return { ok: false, created: false, batch: null, message: `规则 ${ruleNo} 的适用范围内没有待校验的新样本` }
    }
    if (!outcome.created) {
      const existing = outcome.batch
      if (existing.status === '已中断') {
        const resumed = await runBatchLoop(existing.batchNo, options)
        return {
          ...resumed,
          message: `批次 ${existing.batchNo} 从第 ${existing.nextSampleIndex + 1} 个样本恢复执行。${resumed.message}`,
        }
      }
      return {
        ok: true,
        created: false,
        batch: existing,
        message: `同一数据已生成过批次 ${existing.batchNo}（${existing.status}），未重复生成、未重复扣减`,
      }
    }
    const result = await runBatchLoop(outcome.batch.batchNo, options)
    return { ...result, created: true }
  })
}

/** 恢复中断批次：从下一样本继续，已判定样本与额度扣减保持不变。 */
export async function resumeBatch(batchNo: string, options: RunOptions = {}): Promise<BatchRunResult> {
  const batch = getBatch(batchNo)
  if (!batch) {
    return { ok: false, created: false, batch: null, message: `没有找到批次 ${batchNo}` }
  }
  if (batch.status !== '已中断') {
    return { ok: false, created: false, batch, message: `批次 ${batchNo} 当前状态「${batch.status}」，无需恢复` }
  }
  return withBatchLock(batch.ruleNo, () => runBatchLoop(batchNo, options))
}

/**
 * 变更判定口径：生成新口径版本，生效起始样本 = 下一个未校验样本。
 * 之后的样本用新判定；已生成批次与证据保留原范围、原口径快照。
 */
export function changeJudgment(
  ruleNo: string,
  judgment: JudgmentSpec,
): { version: number; effectiveFromSample: number } {
  return mutateState((state) => {
    const rule = state.rules.find((item) => item.ruleNo === ruleNo)
    if (!rule) {
      throw new Error(`没有找到校验规则 ${ruleNo}`)
    }
    const own = state.batches.filter((batch) => batch.ruleNo === ruleNo)
    const coveredTo = own.reduce((max, batch) => Math.max(max, batch.windowTo), 0)
    const effectiveFromSample = Math.max(rule.scope.sourceFrom, coveredTo + 1)
    const current = currentVersion(rule)
    const version: RuleVersionShape = {
      version: rule.currentVersion + 1,
      effectiveFromSample,
      judgment: { ...judgment },
      anomalyThreshold: current.anomalyThreshold,
      blockLevel: current.blockLevel,
      createdAt: new Date().toISOString(),
    }
    rule.versions.push(version)
    rule.currentVersion = version.version
    return { version: version.version, effectiveFromSample }
  })
}

/** 落盘入口：阻断批次一律拒绝落盘；待落盘清单可执行落盘。 */
export function attemptPersist(manifestNo: string): { ok: boolean; message: string } {
  return mutateState((state) => {
    const entry = state.manifest.find((item) => item.manifestNo === manifestNo)
    if (!entry) {
      return { ok: false, message: `没有找到落盘清单 ${manifestNo}` }
    }
    if (entry.status === '已阻断') {
      return {
        ok: false,
        message: `清单 ${manifestNo} 关联批次 ${entry.batchNo} 已被校验阻断，禁止落盘：${entry.blockReason ?? ''}`,
      }
    }
    if (entry.status === '已落盘') {
      return { ok: false, message: `清单 ${manifestNo} 已落盘，无需重复执行` }
    }
    entry.status = '已落盘'
    entry.updatedAt = new Date().toISOString()
    return { ok: true, message: `清单 ${manifestNo} 已落盘（批次 ${entry.batchNo}）` }
  })
}

/** 演示/测试用：重置引擎数据。 */
export function resetValidation(): void {
  resetValidationStore()
}
