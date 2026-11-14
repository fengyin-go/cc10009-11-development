import { beforeEach, describe, expect, it } from 'vitest'

import {
  attemptPersist,
  changeJudgment,
  generateAndRunBatch,
  getBatch,
  judgeSample,
  listBatches,
  listManifest,
  quotaView,
  resetValidation,
  resumeBatch,
} from '@/api/validation-service'
import { sampleRowAt, sampleWindow } from '@/data/sample-dataset'
import type { JudgmentSpec } from '@/data/validation-types'

const V1_JUDGMENT: JudgmentSpec = {
  amountMin: 1,
  amountMax: 1_000_000,
  phoneMinLength: 9,
  phoneMaxLength: 16,
}

const RUN = { chunkSize: 50, chunkDelayMs: 0 }

beforeEach(() => {
  resetValidation()
})

describe('抽样数据集', () => {
  it('窗口一（源行 1–250）抽样 200 行，内置 7 行金额越界 + 3 行手机号长度错误', () => {
    const rows = sampleWindow(1, 250)
    expect(rows).toHaveLength(200)
    const verdicts = rows.map((row) => judgeSample(row, V1_JUDGMENT, 1))
    const abnormal = verdicts.filter((v) => v.abnormal)
    const amountBad = abnormal.filter((v) => v.violations.some((t) => t.startsWith('amount_cents')))
    const phoneBad = abnormal.filter((v) => v.violations.some((t) => t.startsWith('phone_e164')))
    expect(abnormal).toHaveLength(10)
    expect(amountBad).toHaveLength(7)
    expect(phoneBad).toHaveLength(3)
  })

  it('异常行 17、88、159、204 带原值出现', () => {
    expect(sampleRowAt(17).amount_cents).toBe(9_999_999)
    expect(sampleRowAt(88).amount_cents).toBe(-12_345)
    expect(sampleRowAt(159).amount_cents).toBe(88_000_000)
    expect(sampleRowAt(204).amount_cents).toBe(7_500_000)
    const sampledRowNos = new Set(sampleWindow(1, 250).map((row) => row.rowNo))
    for (const rowNo of [17, 88, 159, 204]) {
      expect(sampledRowNos.has(rowNo)).toBe(true)
      expect(judgeSample(sampleRowAt(rowNo), V1_JUDGMENT, 1).abnormal).toBe(true)
    }
  })

  it('数据确定性：同一行号多次读取结果一致', () => {
    expect(sampleRowAt(88)).toEqual(sampleRowAt(88))
    expect(sampleWindow(1, 250)).toEqual(sampleWindow(1, 250))
  })
})

describe('校验批次生成与阻断', () => {
  it('超过阻断级别：批次阻断、列出十条样例证据并保留原行号与原值、阻止落盘', async () => {
    const result = await generateAndRunBatch('VAL-51', RUN)
    expect(result.ok).toBe(true)
    const batch = result.batch!
    expect(batch.status).toBe('已阻断')
    expect(batch.blockedPersist).toBe(true)
    expect(batch.totalSamples).toBe(200)
    expect(batch.processedSamples).toBe(200)
    expect(batch.anomalyCount).toBe(10)
    expect(batch.amountViolations).toBe(7)
    expect(batch.phoneViolations).toBe(3)

    // 十条样例证据，保留原行号与原值
    expect(batch.evidence).toHaveLength(10)
    const evidenceRows = batch.evidence.map((v) => v.rowNo)
    for (const rowNo of [17, 88, 159, 204]) {
      expect(evidenceRows).toContain(rowNo)
    }
    const byRow = new Map(batch.evidence.map((v) => [v.rowNo, v]))
    expect(byRow.get(17)!.amount_cents).toBe(9_999_999)
    expect(byRow.get(88)!.amount_cents).toBe(-12_345)
    expect(byRow.get(159)!.amount_cents).toBe(88_000_000)
    expect(byRow.get(204)!.amount_cents).toBe(7_500_000)
    expect(byRow.get(17)!.phone_e164).toBe(sampleRowAt(17).phone_e164)

    // 范围边界与判定口径快照可复核
    expect(batch.windowFrom).toBe(1)
    expect(batch.windowTo).toBe(250)
    expect(batch.judgment).toEqual(V1_JUDGMENT)
    expect(batch.ruleVersion).toBe(1)
    expect(batch.verdicts).toHaveLength(200)
    expect(batch.verdicts.every((v) => v.ruleVersion === 1)).toBe(true)

    // 落盘清单同步阻断结果
    const manifest = listManifest()
    expect(manifest).toHaveLength(1)
    expect(manifest[0].status).toBe('已阻断')
    expect(manifest[0].evidenceCount).toBe(10)
    expect(manifest[0].blockReason).toContain('10')
    const persist = attemptPersist(manifest[0].manifestNo)
    expect(persist.ok).toBe(false)
    expect(persist.message).toContain('禁止落盘')
  })

  it('并发执行同一数据只生成一次校验批次，重复提交不重复扣减', async () => {
    const [a, b] = await Promise.all([
      generateAndRunBatch('VAL-51', RUN),
      generateAndRunBatch('VAL-51', RUN),
    ])
    expect(a.batch!.batchNo).toBe(b.batch!.batchNo)
    expect(listBatches('VAL-51')).toHaveLength(1)
    expect(quotaView().used).toBe(200)

    // 窗口一终态后，并发提交下一窗口：同样只生成一批，各自只扣减一次
    const [c, d] = await Promise.all([
      generateAndRunBatch('VAL-51', RUN),
      generateAndRunBatch('VAL-51', RUN),
    ])
    expect(c.batch!.batchNo).toBe(d.batch!.batchNo)
    expect(c.batch!.batchNo).not.toBe(a.batch!.batchNo)
    expect(listBatches('VAL-51')).toHaveLength(2)
    expect(quotaView().used).toBe(400)

    // 适用范围内样本全部校验完毕：重复提交不再生成批次、不再扣减
    const again = await generateAndRunBatch('VAL-51', RUN)
    expect(again.created).toBe(false)
    expect(again.batch).toBeNull()
    expect(listBatches('VAL-51')).toHaveLength(2)
    expect(quotaView().used).toBe(400)
  })

  it('服务中断后从下一样本恢复，不重头重跑、不重复扣减', async () => {
    const interrupted = await generateAndRunBatch('VAL-51', { ...RUN, interruptAfterChunks: 2 })
    expect(interrupted.batch!.status).toBe('已中断')
    expect(interrupted.batch!.processedSamples).toBe(100)
    expect(interrupted.batch!.nextSampleIndex).toBe(100)
    expect(quotaView().used).toBe(100)

    const resumed = await resumeBatch(interrupted.batch!.batchNo, RUN)
    expect(resumed.ok).toBe(true)
    const batch = resumed.batch!
    expect(batch.status).toBe('已阻断')
    expect(batch.processedSamples).toBe(200)
    expect(batch.verdicts).toHaveLength(200)
    // 原行号无重复、无遗漏：从下一样本续跑
    const rowNos = batch.verdicts.map((v) => v.rowNo).sort((x, y) => x - y)
    expect(rowNos[0]).toBe(1)
    expect(rowNos[199]).toBe(249)
    expect(new Set(rowNos).size).toBe(200)
    expect(rowNos.every((rowNo) => rowNo % 5 !== 0)).toBe(true)
    // 扣减按实际处理样本记账：100 + 100 = 200，不是 300
    expect(quotaView().used).toBe(200)
    expect(listBatches('VAL-51')).toHaveLength(1)
  })

  it('中断后重复提交同一数据：恢复同一批次而不是新建', async () => {
    const interrupted = await generateAndRunBatch('VAL-51', { ...RUN, interruptAfterChunks: 1 })
    const again = await generateAndRunBatch('VAL-51', RUN)
    expect(again.batch!.batchNo).toBe(interrupted.batch!.batchNo)
    expect(again.batch!.status).toBe('已阻断')
    expect(listBatches('VAL-51')).toHaveLength(1)
    expect(quotaView().used).toBe(200)
  })
})

describe('口径版本切换', () => {
  it('规则口径变化后只对之后样本使用新判定，旧证据保留原范围', async () => {
    const first = await generateAndRunBatch('VAL-51', RUN)
    expect(first.batch!.status).toBe('已阻断')
    const oldBatchNo = first.batch!.batchNo

    // 口径变更：金额上限放宽到 5_000_000，生效起始样本 = 251
    const change = changeJudgment('VAL-51', { ...V1_JUDGMENT, amountMax: 5_000_000 })
    expect(change.version).toBe(2)
    expect(change.effectiveFromSample).toBe(251)

    const second = await generateAndRunBatch('VAL-51', RUN)
    expect(second.created).toBe(true)
    const batch2 = second.batch!
    expect(batch2.batchNo).not.toBe(oldBatchNo)
    expect(batch2.ruleVersion).toBe(2)
    expect(batch2.windowFrom).toBe(251)
    expect(batch2.windowTo).toBe(500)
    // 262、318 行金额 2_000_000 / 3_500_000：v1 口径越界，v2 口径合法
    expect(batch2.anomalyCount).toBe(0)
    expect(batch2.status).toBe('已完成')
    expect(batch2.judgment.amountMax).toBe(5_000_000)

    // 旧批次证据保留原范围、原口径，不被新判定改写
    const old = getBatch(oldBatchNo)!
    expect(old.status).toBe('已阻断')
    expect(old.windowFrom).toBe(1)
    expect(old.windowTo).toBe(250)
    expect(old.judgment).toEqual(V1_JUDGMENT)
    expect(old.evidence).toHaveLength(10)
    expect(old.evidence.map((v) => v.rowNo)).toContain(17)

    // 新窗口落盘清单为待落盘，可执行落盘
    const entry = listManifest().find((item) => item.batchNo === batch2.batchNo)!
    expect(entry.status).toBe('待落盘')
    const persist = attemptPersist(entry.manifestNo)
    expect(persist.ok).toBe(true)
    expect(listManifest().find((item) => item.batchNo === batch2.batchNo)!.status).toBe('已落盘')
    // 旧窗口清单仍是已阻断
    expect(listManifest().find((item) => item.batchNo === oldBatchNo)!.status).toBe('已阻断')
  })

  it('v1 口径下窗口二有 2 行金额越界，用于对照口径切换效果', () => {
    const verdicts = sampleWindow(251, 500).map((row) => judgeSample(row, V1_JUDGMENT, 1))
    const abnormal = verdicts.filter((v) => v.abnormal)
    expect(abnormal.map((v) => v.rowNo).sort((a, b) => a - b)).toEqual([262, 318])
  })
})
