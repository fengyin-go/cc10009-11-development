<template>
  <section class="page" data-module="validator">
    <header class="page-head">
      <div>
        <h2>结果校验管理</h2>
        <p class="page-desc">维护结果校验规则的输入、执行约束与结果记录，为结果校验提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记校验规则</button>
        <button class="btn" type="button" @click="exportRows">导出结果校验清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无结果校验数据，可先登记校验规则</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条结果校验记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- VAL-51 校验批次引擎 -->
    <section class="batch-section" data-component="validation-batches">
      <header class="section-head">
        <div>
          <h3>VAL-51 校验批次</h3>
          <p class="section-note">
            按校验规则、适用范围、判定口径与异常阈值生成可执行批次；同一数据并发执行只生成一批，
            超阈值即阻断落盘并保留十条样例证据。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" :disabled="running" @click="generate">
            {{ running ? '执行中…' : '生成并执行校验批次' }}
          </button>
          <button class="btn" type="button" :disabled="!running" @click="interrupt">模拟服务中断</button>
          <button class="btn ghost" type="button" @click="judgmentFormOpen = !judgmentFormOpen">
            变更判定口径
          </button>
        </div>
      </header>

      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">校验额度总量</span>
          <strong class="stat-value">{{ quota.total }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">已扣减（按批次记账）</span>
          <strong class="stat-value">{{ quota.used }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">剩余额度</span>
          <strong class="stat-value">{{ quota.remaining }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">当前口径版本</span>
          <strong class="stat-value">v{{ rule?.currentVersion ?? '—' }}</strong>
        </article>
      </div>

      <form v-if="judgmentFormOpen" class="judgment-form" @submit.prevent="submitJudgment">
        <span class="form-title">新判定口径（仅对之后样本生效，旧证据保留原范围）</span>
        <label>
          <span>金额下限（分）</span>
          <input v-model.number="judgmentForm.amountMin" type="number" />
        </label>
        <label>
          <span>金额上限（分）</span>
          <input v-model.number="judgmentForm.amountMax" type="number" />
        </label>
        <label>
          <span>手机号最小长度</span>
          <input v-model.number="judgmentForm.phoneMinLength" type="number" />
        </label>
        <label>
          <span>手机号最大长度</span>
          <input v-model.number="judgmentForm.phoneMaxLength" type="number" />
        </label>
        <button class="btn primary" type="submit">提交口径变更</button>
      </form>

      <p v-if="rule" class="version-line">
        <span v-for="version in rule.versions" :key="version.version" class="legend-item">
          v{{ version.version }}：自源行 {{ version.effectiveFromSample }} 起生效（金额
          {{ version.judgment.amountMin }}–{{ version.judgment.amountMax }} 分，手机号
          {{ version.judgment.phoneMinLength }}–{{ version.judgment.phoneMaxLength }} 位，阈值
          {{ version.anomalyThreshold }}）
        </span>
      </p>

      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>口径版本</th>
            <th>范围边界（源行）</th>
            <th>抽样行数</th>
            <th>执行进度</th>
            <th>异常（金额/手机号）</th>
            <th>异常阈值</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.batchNo">
            <td>{{ batch.batchNo }}</td>
            <td>v{{ batch.ruleVersion }}</td>
            <td>{{ batch.windowFrom }}–{{ batch.windowTo }}</td>
            <td>{{ batch.totalSamples }}</td>
            <td>{{ batch.processedSamples }}/{{ batch.totalSamples }}</td>
            <td>{{ batch.anomalyCount }}（{{ batch.amountViolations }}/{{ batch.phoneViolations }}）</td>
            <td>{{ batch.anomalyThreshold }}</td>
            <td><span class="tag" :class="batchStatusClass(batch.status)">{{ batch.status }}</span></td>
            <td class="row-actions">
              <button
                v-if="batch.status === '已中断'"
                class="link"
                type="button"
                @click="resume(batch.batchNo)"
              >
                恢复执行
              </button>
              <button class="link" type="button" @click="selectBatch(batch.batchNo)">复核证据</button>
            </td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="9" class="empty-state">
              规则 VAL-51 已保存，还没有可执行批次，点击「生成并执行校验批次」开始
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="selected" class="batch-detail">
        <header class="section-head">
          <div>
            <h3>批次复核：{{ selected.batchNo }}</h3>
            <p class="section-note">
              范围边界：源行 {{ selected.windowFrom }}–{{ selected.windowTo }}（采样比例
              {{ selected.sampleRatioLabel }}，抽样 {{ selected.totalSamples }} 行）；判定口径快照：金额
              {{ selected.judgment.amountMin }}–{{ selected.judgment.amountMax }} 分、手机号长度
              {{ selected.judgment.phoneMinLength }}–{{ selected.judgment.phoneMaxLength }} 位；异常阈值
              {{ selected.anomalyThreshold }}；阻断级别：{{ selected.blockLevel }}；幂等键：{{ selected.idempotencyKey }}
            </p>
          </div>
          <button class="btn ghost" type="button" @click="selectedBatchNo = ''">收起</button>
        </header>

        <template v-if="selected.evidence.length">
          <h4 class="evidence-title">
            样例证据（{{ selected.evidence.length }} 条，保留原行号与原值）
          </h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>原行号</th>
                <th>amount_cents</th>
                <th>phone_e164</th>
                <th>违反判定</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in selected.evidence" :key="item.rowNo">
                <td>{{ item.rowNo }}</td>
                <td>{{ item.amount_cents }}</td>
                <td>{{ item.phone_e164 }}</td>
                <td>{{ item.violations.join('；') }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <h4 class="evidence-title">全量判定（{{ selected.verdicts.length }} 行，可复核）</h4>
        <div class="verdict-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>原行号</th>
                <th>amount_cents</th>
                <th>phone_e164</th>
                <th>口径版本</th>
                <th>判定结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in selected.verdicts" :key="item.rowNo" :class="{ 'row-abnormal': item.abnormal }">
                <td>{{ item.rowNo }}</td>
                <td>{{ item.amount_cents }}</td>
                <td>{{ item.phone_e164 }}</td>
                <td>v{{ item.ruleVersion }}</td>
                <td>{{ item.abnormal ? item.violations.join('；') : '通过' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p v-if="batchMessage" class="batch-message">{{ batchMessage }}</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  changeJudgment,
  generateAndRunBatch,
  getRule,
  listBatches,
  quotaView,
  requestInterrupt,
  resumeBatch,
} from '@/api/validation-service'
import type { EntryRow } from '@/data/types'
import type { BatchStatus, ValidationBatch, ValidationRule } from '@/data/validation-types'

const meta = moduleMeta('validator')
const columns = ["规则编号", "校验对象", "校验类型", "校验表达式", "期望值范围", "采样比例", "异常阈值", "阻断级别"]
const actions = ["提交校验", "启用规则", "停用规则"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "校验规则总数", "value": 0}, {"label": "已启用规则", "value": 0}, {"label": "待校验规则", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// ---------- VAL-51 批次引擎 ----------

const RULE_NO = 'VAL-51'
const rule = ref<ValidationRule | null>(null)
const batches = ref<ValidationBatch[]>([])
const quota = ref({ total: 0, used: 0, remaining: 0 })
const running = ref(false)
const batchMessage = ref('')
const selectedBatchNo = ref('')
const judgmentFormOpen = ref(false)
const judgmentForm = reactive({
  amountMin: 1,
  amountMax: 5_000_000,
  phoneMinLength: 9,
  phoneMaxLength: 16,
})

const selected = computed(
  () => batches.value.find((batch) => batch.batchNo === selectedBatchNo.value) ?? null,
)

function batchStatusClass(status: BatchStatus): string {
  if (status === '已阻断') return 'tag-blocked'
  if (status === '已完成') return 'tag-done'
  if (status === '已中断') return 'tag-interrupted'
  return 'tag-running'
}

function refreshEngine() {
  rule.value = getRule(RULE_NO)
  batches.value = listBatches(RULE_NO)
  quota.value = quotaView()
}

async function generate() {
  if (running.value) return
  running.value = true
  batchMessage.value = ''
  try {
    const result = await generateAndRunBatch(RULE_NO)
    batchMessage.value = result.message
  } finally {
    running.value = false
    refreshEngine()
  }
}

async function resume(batchNo: string) {
  if (running.value) return
  running.value = true
  batchMessage.value = ''
  try {
    const result = await resumeBatch(batchNo)
    batchMessage.value = result.message
  } finally {
    running.value = false
    refreshEngine()
  }
}

function interrupt() {
  requestInterrupt()
  batchMessage.value = '已请求中断：当前分块落账后批次标记为「已中断」，可从下一样本恢复'
}

function submitJudgment() {
  const change = changeJudgment(RULE_NO, { ...judgmentForm })
  batchMessage.value = `已生成口径版本 v${change.version}，自源行 ${change.effectiveFromSample} 起生效；此前批次与证据保留原范围、原口径`
  judgmentFormOpen.value = false
  refreshEngine()
}

function selectBatch(batchNo: string) {
  selectedBatchNo.value = selectedBatchNo.value === batchNo ? '' : batchNo
}

function onEngineChanged() {
  refreshEngine()
}

// ---------- 通用规则表 ----------

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '校验规则登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '结果校验列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshEngine()
  window.addEventListener('validation:changed', onEngineChanged)
})

onUnmounted(() => {
  window.removeEventListener('validation:changed', onEngineChanged)
})
</script>

<style scoped>
.batch-section {
  margin-top: 24px;
  border-top: 2px solid var(--border);
  padding-top: 16px;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
}
.section-head h3 {
  margin: 0;
  font-size: 15px;
}
.section-note {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  max-width: 720px;
}
.judgment-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.judgment-form .form-title {
  width: 100%;
  font-size: 12px;
  color: var(--muted);
}
.judgment-form label span {
  display: block;
  font-size: 12px;
  color: var(--muted);
}
.version-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 12px;
}
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.tag-blocked {
  background: #fee4e2;
  color: #b42318;
}
.tag-done {
  background: #dcfae6;
  color: #067647;
}
.tag-interrupted {
  background: #fef0c7;
  color: #b54708;
}
.tag-running {
  background: #dbeafe;
  color: #1d4ed8;
}
.batch-detail {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.evidence-title {
  margin: 12px 0 8px;
  font-size: 13px;
}
.verdict-scroll {
  max-height: 320px;
  overflow: auto;
}
.row-abnormal td {
  background: #fff5f5;
}
.batch-message {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--brand);
}
</style>
