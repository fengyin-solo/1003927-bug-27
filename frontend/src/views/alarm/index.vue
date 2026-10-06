<template>
  <section class="page" data-module="alarm">
    <header class="page-head">
      <div>
        <h2>预警发布管理</h2>
        <p class="page-desc">登记预警通知草稿、发布到接收单位、跟踪回执并登记响应与解除结论。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="goCreate">登记预警通知</button>
        <button class="btn" type="button" @click="exportRows">导出预警发布清单</button>
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

    <div class="channel-bar">
      <label class="channel-toggle">
        <input type="checkbox" :checked="channelDown" @change="toggleChannel" />
        演练开关：模拟发布通道中断（开启后发布将在「下发 / 回执」步骤失败，可用于验证失败保留与重试）
      </label>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>通知编号</span>
        <input v-model="filters.code" placeholder="按通知编号检索" />
      </label>
      <label class="filter-item">
        <span>隐患点编号</span>
        <input v-model="filters.hazardCode" placeholder="按隐患点编号检索" />
      </label>
      <label class="filter-item">
        <span>预警等级</span>
        <input v-model="filters.level" placeholder="按预警等级检索" />
      </label>
      <label class="filter-item">
        <span>通知状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
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
        <tr v-for="row in rows" :key="row.id">
          <td><button class="link" type="button" @click="goDetail(row.id)">{{ row.code }}</button></td>
          <td>{{ row.hazardCode }}</td>
          <td>{{ row.level }}</td>
          <td class="cell-clip" :title="row.triggerCondition">{{ row.triggerCondition || '—' }}</td>
          <td>{{ row.publishedAt || (['已发布', '已响应', '已解除'].includes(row.status) ? '—' : '未发布') }}</td>
          <td>
            <template v-if="recipientUnits(row).length">
              {{ recipientUnits(row).join('、') }}
            </template>
            <span v-else class="warn-text">待分派</span>
          </td>
          <td>{{ row.publisher || '—' }}</td>
          <td>
            <span class="status-badge" :class="badgeClass(row.status)">{{ row.status }}</span>
            <p v-if="row.status === '发布失败'" class="cell-note error-text" :title="row.failureReason">
              失败步骤：{{ row.failedStep }}｜{{ row.failureReason }}
            </p>
            <p v-else-if="abnormalCount(row) > 0" class="cell-note warn-text">
              {{ abnormalCount(row) }} 个异常回执，见详情说明
            </p>
            <p v-else-if="row.status === '待分派'" class="cell-note muted-text">
              接收单位为空，等待分派后发布
            </p>
            <p v-else-if="row.status === '已解除'" class="cell-note muted-text" :title="row.releaseConclusion">
              解除于 {{ row.releasedAt }}，结论已归档
            </p>
          </td>
          <td class="row-actions">
            <template v-for="action in availableActions(row)" :key="action.label">
              <button
                class="link"
                type="button"
                :disabled="action.busy || !action.enabled"
                :title="action.hint"
                @click="runAction(action, row)"
              >
                {{ action.busy ? `${action.label}中…` : action.label }}
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警通知，可先登记草稿</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警通知</span>
      <span v-if="flash" :class="flash.ok ? 'success-text' : 'error-text'">{{ flash.text }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { downloadCsv } from './helpers'
import {
  abnormalReceiptCount,
  exportNotices,
  inflightIds,
  isChannelDown,
  listNotices,
  publishNotice,
  setChannelDown,
  splitRecipients,
} from '@/data/alarm/store'
import type { AlarmNotice, AlarmStatus } from '@/data/alarm/types'

const router = useRouter()
const columns = ['通知编号', '隐患点编号', '预警等级', '触发条件', '发布时间', '接收单位', '发布人']
const statuses: AlarmStatus[] = ['草稿', '待发布', '待分派', '发布中', '发布失败', '已发布', '已响应', '已解除', '误报']

const rows = ref<AlarmNotice[]>([])
const total = ref(0)
const flash = ref<{ ok: boolean; text: string } | null>(null)
const filters = ref({ code: '', hazardCode: '', level: '', status: '' })
let flashTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let pollDepth = 0

const channelDown = ref(isChannelDown())

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => row.status === status).length })),
)

const stats = computed(() => {
  const now = new Date()
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthRows = rows.value.filter((row) => row.createdAt.startsWith(monthPrefix))
  return [
    { label: '本月预警数', value: monthRows.length },
    { label: '已响应数', value: monthRows.filter((row) => row.status === '已响应' || row.status === '已解除').length },
    { label: '未解除数', value: rows.value.filter((row) => !['已解除', '误报'].includes(row.status)).length },
  ]
})

function recipientUnits(row: AlarmNotice): string[] {
  return splitRecipients(row.recipientsText)
}

function abnormalCount(row: AlarmNotice): number {
  return abnormalReceiptCount(row)
}

function badgeClass(status: AlarmStatus): string {
  if (status === '发布失败') return 'badge-fail'
  if (status === '发布中') return 'badge-busy'
  if (status === '待分派') return 'badge-warn'
  if (status === '已发布' || status === '已响应') return 'badge-ok'
  if (status === '已解除' || status === '误报') return 'badge-done'
  return 'badge-idle'
}

type RowAction = {
  key: string
  label: string
  enabled: boolean
  busy: boolean
  hint: string
}

function availableActions(row: AlarmNotice): RowAction[] {
  const busy = inflightIds.has(row.id)
  const publish: RowAction = {
    key: 'publish',
    label: row.status === '发布失败' ? '重试发布' : '确认发布',
    enabled: !busy,
    busy,
    hint:
      row.status === '发布失败'
        ? `从「${row.failedStep ?? '校验'}」步骤继续，草稿与接收单位已保留`
        : '执行校验、下发、回执三步发布',
  }
  const detail: RowAction = { key: 'detail', label: '详情', enabled: true, busy: false, hint: '查看通知详情' }
  const edit: RowAction = { key: 'edit', label: '编辑', enabled: !busy, busy: false, hint: '修改草稿与接收单位' }
  const dispatch: RowAction = { key: 'dispatch', label: '分派接收单位', enabled: !busy, busy: false, hint: '补填接收单位后发布' }
  const respond: RowAction = { key: 'respond', label: '登记响应', enabled: true, busy: false, hint: '登记现场响应处置情况' }
  const release: RowAction = { key: 'release', label: '解除预警', enabled: true, busy: false, hint: '填写解除结论并归档' }

  switch (row.status) {
    case '草稿':
    case '待发布':
      return [detail, edit, publish]
    case '待分派':
      return [detail, dispatch]
    case '发布中':
      return [detail, { ...publish, enabled: false, hint: '正在执行发布流水线' }]
    case '发布失败':
      return [detail, edit, publish]
    case '已发布':
      return [detail, respond, release]
    case '已响应':
      return [detail, release]
    case '已解除':
    case '误报':
      return [detail]
  }
}

function showFlash(ok: boolean, text: string) {
  flash.value = { ok, text }
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flash.value = null
  }, 6000)
}

function toggleChannel(event: Event) {
  const down = (event.target as HTMLInputElement).checked
  setChannelDown(down)
  channelDown.value = down
  showFlash(true, down ? '发布通道已中断（演练）：之后的发布会在下发/回执步骤失败。' : '发布通道已恢复：可重试失败通知。')
}

function resetFilters() {
  filters.value = { code: '', hazardCode: '', level: '', status: '' }
  reload()
}

function exportRows() {
  downloadCsv(exportNotices())
}

function goCreate() {
  router.push('/alarm/new')
}

function goDetail(id: number) {
  router.push(`/alarm/${id}`)
}

function goEdit(id: number) {
  router.push(`/alarm/${id}/edit`)
}

async function runAction(action: RowAction, row: AlarmNotice) {
  flash.value = null
  switch (action.key) {
    case 'detail':
      goDetail(row.id)
      return
    case 'edit':
      goEdit(row.id)
      return
    case 'dispatch':
      router.push({ path: `/alarm/${row.id}`, hash: '#dispatch' })
      return
    case 'respond':
    case 'release':
      router.push({ path: `/alarm/${row.id}`, hash: action.key === 'respond' ? '#respond' : '#release' })
      return
    case 'publish': {
      const result = await publishNotice(row.id)
      showFlash(result.ok, result.message)
      reload()
      return
    }
  }
}

function reload() {
  try {
    const filtered = listNotices({
      code: filters.value.code,
      hazardCode: filters.value.hazardCode,
      level: filters.value.level,
      status: filters.value.status,
    })
    rows.value = filtered
    total.value = filtered.length
  } catch (error) {
    showFlash(false, error instanceof Error ? error.message : '预警通知列表读取失败')
  }
}

onMounted(() => {
  reload()
  // 发布是异步流水线：列表在有发布进行时轮询刷新，结束后自动停
  pollTimer = setInterval(() => {
    const anyBusy = rows.value.some((row) => inflightIds.has(row.id))
    if (anyBusy) {
      pollDepth = 0
      reload()
    } else {
      pollDepth += 1
      // 发布刚结束的最后一轮也刷一次，随后停止轮询
      if (pollDepth > 1) {
        clearInterval(pollTimer)
      } else {
        reload()
      }
    }
  }, 700)
})

onUnmounted(() => {
  clearInterval(pollTimer)
  clearTimeout(flashTimer)
})
</script>

<style scoped>
.channel-bar {
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.channel-toggle {
  display: flex;
  gap: 8px;
  align-items: center;
}
.status-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.badge-idle { background: #eef2f7; color: #475569; }
.badge-busy { background: #e0f2fe; color: #0369a1; }
.badge-warn { background: #fef3c7; color: #92400e; }
.badge-fail { background: #fee2e2; color: #b42318; }
.badge-ok { background: #dcfce7; color: #166534; }
.badge-done { background: #f1f5f9; color: #334155; }
.cell-clip { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-note { margin: 2px 0 0; font-size: 12px; max-width: 260px; }
.muted-text { color: #64748b; }
.warn-text { color: #b45309; }
.success-text { color: #166534; }
.link:disabled { color: #94a3b8; cursor: not-allowed; }
</style>
