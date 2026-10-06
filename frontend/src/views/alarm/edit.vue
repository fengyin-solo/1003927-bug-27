<template>
  <section class="page" data-module="alarm-edit">
    <header class="page-head">
      <div>
        <h2>{{ isCreate ? '登记预警通知' : '编辑预警通知' }}</h2>
        <p class="page-desc">先保存草稿或直接提交发布；接收单位为空不会报错，通知会转入待分派。</p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" type="button" @click="back">返回</button>
      </div>
    </header>

    <div v-if="missing" class="empty-state">未找到该预警通知，可能已被重置。</div>

    <template v-else>
      <div v-if="original?.status === '发布失败'" class="alert fail">
        <strong>该通知此前发布失败（停在「{{ original.failedStep }}」步骤）</strong>
        <p>{{ original.failureReason }}</p>
        <p class="muted">
          原草稿与接收单位均保留在下方表单中，可直接修改后保存；也可
          <button class="link" type="button" @click="goDetail">回到详情页重试发布</button>，
          重试从失败步骤继续。若调整了接收单位，重试将自动从校验步骤重新开始。
        </p>
      </div>
      <div v-else-if="terminal" class="alert done">
        <strong>通知已{{ original?.status }}，历史结论保留，不能再编辑。</strong>
        <p v-if="original?.releaseConclusion">{{ original.releaseConclusion }}</p>
      </div>

      <form class="editor-card" @submit.prevent="submit(true)">
        <label class="form-row">
          <span class="form-label">隐患点编号 <i>*</i></span>
          <input v-model="form.hazardCode" placeholder="例如 HAZA-0017" />
        </label>
        <label class="form-row">
          <span class="form-label">预警等级 <i>*</i></span>
          <select v-model="form.level">
            <option value="">请选择</option>
            <option value="注意级">注意级</option>
            <option value="警示级">警示级</option>
            <option value="警戒级">警戒级</option>
          </select>
        </label>
        <label class="form-row">
          <span class="form-label">发布人 <i>*</i></span>
          <input v-model="form.publisher" placeholder="例如 值班管理员" />
        </label>
        <label class="form-row full">
          <span class="form-label">触发条件 <i>*</i></span>
          <textarea v-model="form.triggerCondition" rows="2" placeholder="例如：过去3小时累计雨量超过警示级阈值"></textarea>
        </label>
        <label class="form-row full">
          <span class="form-label">通知正文（草稿） <i>*</i></span>
          <textarea v-model="form.draftContent" rows="4" placeholder="通知下发给接收单位的正文，发布失败也会原样保留"></textarea>
        </label>
        <label class="form-row full">
          <span class="form-label">
            接收单位
            <em class="form-hint">每行一个单位；留空提交将转入「待分派」而不是发布失败。单位名称含「测试异常」可模拟异常回执。</em>
          </span>
          <textarea v-model="form.recipientsText" rows="4" placeholder={'尖山沟村委会\n自然资源所\n应急办'}></textarea>
        </label>

        <p v-if="errorMessage" class="error-text editor-error">{{ errorMessage }}</p>

        <div class="editor-foot">
          <button class="btn" type="button" :disabled="locked" @click="submit(false)">保存草稿</button>
          <button class="btn primary" type="submit" :disabled="locked">
            {{ locked ? '提交中…' : recipientCount === 0 ? '提交（进入待分派）' : '提交并发布' }}
          </button>
        </div>
      </form>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { createNotice, getNotice, inflightIds, publishNotice, saveDraft } from '@/data/alarm/store'
import type { AlarmDraftInput } from '@/data/alarm/types'

const route = useRoute()
const router = useRouter()
const rawId = route.params.id as string | undefined
const isCreate = rawId === undefined || rawId === 'new'
const id = isCreate ? 0 : Number(rawId)

const original = ref(isCreate ? undefined : getNotice(id))
const missing = ref(!isCreate && !original.value)
const errorMessage = ref('')

const emptyForm: AlarmDraftInput = {
  hazardCode: '',
  level: '注意级',
  triggerCondition: '',
  publisher: '值班管理员',
  recipientsText: '',
  draftContent: '',
}
const form = ref<AlarmDraftInput>({ ...emptyForm })
// 打开表单时的版本号，作为乐观锁依据
const baseVersion = ref<number | null>(null)

const submitting = ref(false)
const terminal = computed(() => original.value?.status === '已解除' || original.value?.status === '误报')
const locked = computed(() => submitting.value || (!isCreate && inflightIds.has(id)))
const recipientCount = computed(() =>
  form.value.recipientsText
    .split(/[\n,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean).length,
)

function back() {
  router.push(isCreate ? '/alarm' : `/alarm/${id}`)
}

function goDetail() {
  router.push(`/alarm/${id}`)
}

async function submit(publish: boolean) {
  errorMessage.value = ''
  if (terminal.value) {
    errorMessage.value = '终态通知不能修改。'
    return
  }
  // 提交发布时校验必填；只保存草稿则允许字段不全
  if (publish) {
    const missingField =
      !form.value.hazardCode.trim() ||
      !form.value.level.trim() ||
      !form.value.publisher.trim() ||
      !form.value.triggerCondition.trim() ||
      !form.value.draftContent.trim()
    if (missingField) {
      errorMessage.value = '隐患点编号、预警等级、发布人、触发条件、通知正文为发布必填项；也可以先保存草稿。'
      return
    }
  }

  const result = isCreate
    ? createNotice(form.value, publish)
    : saveDraft(id, form.value, baseVersion.value ?? undefined)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }

  // 要发布：保存（或新建）成功后立刻进入三步流水线；空接收单位由 store 转入待分派
  if (publish) {
    const targetId = isCreate ? result.id : id
    if (result.diverted || targetId === undefined) {
      router.push('/alarm')
      return
    }
    submitting.value = true
    try {
      const publishResult = await publishNotice(targetId)
      if (!publishResult.ok && publishResult.diverted) {
        router.push('/alarm')
        return
      }
      // 无论成功失败都进详情：成功看回执，失败看保留的失败原因与重试入口
      router.push(`/alarm/${targetId}`)
      return
    } finally {
      submitting.value = false
    }
  }

  if (isCreate) {
    router.push(result.id !== undefined ? `/alarm/${result.id}` : '/alarm')
    return
  }
  router.push(`/alarm/${id}`)
}

onMounted(() => {
  if (!isCreate) {
    const notice = getNotice(id)
    original.value = notice
    missing.value = !notice
    if (notice && !terminal.value) {
      baseVersion.value = notice.version
      form.value = {
        hazardCode: notice.hazardCode,
        level: notice.level || '注意级',
        triggerCondition: notice.triggerCondition,
        publisher: notice.publisher,
        recipientsText: notice.recipientsText,
        draftContent: notice.draftContent,
      }
    }
  }
})
</script>

<style scoped>
.editor-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.form-row { display: flex; flex-direction: column; gap: 4px; }
.form-row.full { grid-column: 1 / -1; }
.form-label { font-size: 13px; color: #334155; }
.form-label i { color: #dc2626; font-style: normal; }
.form-hint { color: var(--muted); font-size: 12px; font-style: normal; margin-left: 6px; }
.form-row input,
.form-row select,
.form-row textarea {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
}
.editor-foot { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
.editor-error { grid-column: 1 / -1; margin: 0; }
.alert { border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; border: 1px solid; }
.alert strong { display: block; margin-bottom: 4px; }
.alert p { margin: 4px 0; }
.alert.fail { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
.alert.done { background: #f8fafc; border-color: #cbd5e1; color: #334155; }
.muted { color: var(--muted); }
.btn:disabled { color: #94a3b8; cursor: not-allowed; }
</style>
