<template>
  <section class="manifest-panel" data-component="persist-manifest">
    <header class="manifest-head">
      <div>
        <h3>落盘清单</h3>
        <p class="manifest-note">校验批次结果实时同步：超过阻断级别的批次在此标记「已阻断」并禁止落盘。</p>
      </div>
      <button class="btn ghost" type="button" @click="reload">刷新</button>
    </header>
    <table class="data-table">
      <thead>
        <tr>
          <th>清单号</th>
          <th>数据集</th>
          <th>样本窗口</th>
          <th>关联批次</th>
          <th>异常数</th>
          <th>证据数</th>
          <th>状态</th>
          <th>阻断原因</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in entries" :key="entry.manifestNo">
          <td>{{ entry.manifestNo }}</td>
          <td>{{ entry.dataset }}</td>
          <td>{{ entry.windowLabel }}</td>
          <td>{{ entry.batchNo }}</td>
          <td>{{ entry.anomalyCount }}</td>
          <td>{{ entry.evidenceCount }}</td>
          <td><span class="tag" :class="statusClass(entry.status)">{{ entry.status }}</span></td>
          <td class="reason-cell">{{ entry.blockReason ?? '—' }}</td>
          <td>
            <button
              class="link"
              type="button"
              :disabled="entry.status !== '待落盘'"
              @click="persist(entry.manifestNo)"
            >
              执行落盘
            </button>
          </td>
        </tr>
        <tr v-if="!entries.length">
          <td colspan="9" class="empty-state">暂无落盘清单，等待校验批次生成后同步</td>
        </tr>
      </tbody>
    </table>
    <p v-if="message" class="manifest-message" :class="{ 'error-text': isError }">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import { attemptPersist, listManifest } from '@/api/validation-service'
import type { ManifestStatus, PersistManifestEntry } from '@/data/validation-types'

const entries = ref<PersistManifestEntry[]>([])
const message = ref('')
const isError = ref(false)

function statusClass(status: ManifestStatus): string {
  if (status === '已阻断') return 'tag-blocked'
  if (status === '已落盘') return 'tag-done'
  return 'tag-pending'
}

function reload() {
  entries.value = listManifest()
}

function persist(manifestNo: string) {
  const result = attemptPersist(manifestNo)
  message.value = result.message
  isError.value = !result.ok
  reload()
}

function onChanged() {
  reload()
}

function onStorage(event: StorageEvent) {
  if (event.key && event.key.includes('validation')) {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('validation:changed', onChanged)
  window.addEventListener('storage', onStorage)
})

onUnmounted(() => {
  window.removeEventListener('validation:changed', onChanged)
  window.removeEventListener('storage', onStorage)
})
</script>

<style scoped>
.manifest-panel {
  margin-top: 20px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.manifest-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 10px;
}
.manifest-head h3 {
  margin: 0;
  font-size: 15px;
}
.manifest-note {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
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
.tag-pending {
  background: #fef0c7;
  color: #b54708;
}
.reason-cell {
  max-width: 320px;
  font-size: 12px;
  color: var(--muted);
}
.manifest-message {
  margin: 8px 0 0;
  font-size: 13px;
  color: #067647;
}
.link:disabled {
  color: var(--muted);
  cursor: not-allowed;
}
</style>
