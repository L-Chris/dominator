import { fetchAnswers, getUserId, getUserName, getUserIdFromHref, summarizeAnswers } from '@/api/zhihu'
import type { AnalysisJsonResult, AnalysisTarget, RiskLevel, SimpleAnalysisResult } from '@/types'
import { startDevReloader } from '@/devReload'

startDevReloader('content')

type ChipStatus = 'idle' | 'loading' | 'done' | 'error'

const resultCache = new Map<string, AnalysisJsonResult>()
const simpleResultCache = new Map<string, SimpleAnalysisResult>()
const simpleQueue = new Map<string, AnalysisTarget>()
const simpleInFlight = new Set<string>()
const simpleRetryCounts = new Map<string, number>()
let simpleAnalyzeTimer: number | null = null
let simpleAnalyzing = false
const SIMPLE_BATCH_SIZE = 1
const SIMPLE_MAX_RETRIES = 2
const SIMPLE_AUTO_ANALYSIS_ENABLED = import.meta.env.VITE_ZHIHU_AUTO_QUICK_ANALYSIS !== 'false'
const SIMPLE_AUTO_START_DELAY_MS = getPositiveIntegerEnv('VITE_ZHIHU_AUTO_QUICK_ANALYSIS_DELAY_MS', 2000)
const SIMPLE_FETCH_TIMEOUT_MS = getPositiveIntegerEnv('VITE_ZHIHU_QUICK_ANALYSIS_TIMEOUT_MS', 12000)

chrome.runtime.sendMessage({ type: 'enableSidePanelForCurrentTab' }).catch(() => undefined)

function getQuickAnalysisMaxPages() {
  return getPositiveIntegerEnv('VITE_ZHIHU_QUICK_ANALYSIS_MAX_PAGES', 1)
}

function getPositiveIntegerEnv(key: string, fallback: number) {
  const configured = Number(import.meta.env[key] || fallback)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : fallback
}

function enqueueSimpleAnalysis(target: AnalysisTarget) {
  if (!SIMPLE_AUTO_ANALYSIS_ENABLED) return
  queueSimpleAnalysis(target)
}

function queueSimpleAnalysis(target: AnalysisTarget) {
  if (simpleResultCache.has(target.userId) || simpleInFlight.has(target.userId) || simpleQueue.has(target.userId)) return
  simpleQueue.set(target.userId, target)
  setSimpleTagsStatus(target.userId, 'loading')
  scheduleSimpleAnalysis()
}

function scheduleSimpleAnalysis() {
  if (simpleAnalyzeTimer !== null || simpleAnalyzing) return
  simpleAnalyzeTimer = window.setTimeout(() => {
    simpleAnalyzeTimer = null
    runSimpleAnalysisBatch().catch(() => undefined)
  }, 600)
}

async function runSimpleAnalysisBatch() {
  if (simpleAnalyzing || simpleQueue.size === 0) return
  simpleAnalyzing = true

  const targets = pickSimpleTargets()
  targets.forEach((target) => {
    simpleQueue.delete(target.userId)
    simpleInFlight.add(target.userId)
  })

  try {
    const samples = await Promise.all(
      targets.map(async (target) => ({
        target,
        answers: summarizeAnswers(
          await withTimeout(
            fetchAnswers(getQuickAnalysisMaxPages(), target.userId),
            SIMPLE_FETCH_TIMEOUT_MS,
            `Quick analysis data fetch timed out for ${target.userId}`
          )
        ),
      }))
    )

    const response = await withTimeout(
      quickAnalyzeInBackground({
        platform: 'zhihu',
        users: samples.map(({ target, answers }) => ({
          platformUserId: target.userId,
          userName: target.userName,
          answers,
        })),
      }),
      SIMPLE_FETCH_TIMEOUT_MS,
      'Quick analysis backend request timed out'
    )

    if (!response.ok) throw new Error(`Backend returned ${response.status}`)

    const data = await response.json() as { success: boolean; data?: Array<{ platformUserId: string; riskScore: number; riskLevel: string; tags?: string[]; dimensions?: SimpleAnalysisResult['dimensions'] }> }
    if (!data.success || !data.data) throw new Error('Backend returned invalid result')

    data.data.forEach((result, index) => {
      const target = targets.find((item) => item.userId === result.platformUserId) || targets[index]
      if (!target) return
      const normalized: SimpleAnalysisResult = {
        user_id: target.userId,
        risk_score: normalizeRiskScore(result.riskScore),
        dimensions: normalizeSimpleDimensions(result.dimensions),
        tags: buildTagsFromDimensions(normalizeSimpleDimensions(result.dimensions), normalizeRiskScore(result.riskScore)),
      }
      if (normalized.tags.length === 0) return
      simpleResultCache.set(target.userId, normalized)
      simpleRetryCounts.delete(target.userId)
      updateSimpleTags(target.userId, normalized)
    })
  } catch (err) {
    console.warn('[Dominator] quick analysis failed', err)
    targets.forEach((target) => {
      const retries = simpleRetryCounts.get(target.userId) || 0
      if (retries >= SIMPLE_MAX_RETRIES) {
        setSimpleTagsStatus(target.userId, 'error')
        return
      }
      simpleRetryCounts.set(target.userId, retries + 1)
      queueSimpleAnalysis(target)
    })
  } finally {
    targets.forEach((target) => simpleInFlight.delete(target.userId))
    simpleAnalyzing = false
    if (simpleQueue.size > 0) scheduleSimpleAnalysis()
  }
}

function pickSimpleTargets(): AnalysisTarget[] {
  return Array.from(simpleQueue.values())
    .sort((a, b) => getTargetViewportPriority(b.userId) - getTargetViewportPriority(a.userId))
    .slice(0, SIMPLE_BATCH_SIZE)
}

function getTargetViewportPriority(userId: string): number {
  const element = document.querySelector<HTMLElement>(
    `.za-analysis-row[data-user-id="${CSS.escape(userId)}"], .za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`
  )
  if (!element) return 0

  const host = element.closest<HTMLElement>('.AnswerItem, .List-item, .ContentItem, .AuthorInfo') || element
  const rect = host.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1
  const center = rect.top + rect.height / 2
  const distanceToCenter = Math.abs(center - viewportHeight / 2)
  const visibleTop = Math.max(rect.top, 0)
  const visibleBottom = Math.min(rect.bottom, viewportHeight)
  const visibleHeight = Math.max(0, visibleBottom - visibleTop)
  const visibleRatio = rect.height > 0 ? visibleHeight / rect.height : 0

  if (visibleRatio <= 0) return Math.max(0, 1000 - distanceToCenter)
  return 100000 + visibleRatio * 10000 - distanceToCenter
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function quickAnalyzeInBackground(payload: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'quickAnalyze', payload }, (res) => {
      const runtimeError = chrome.runtime.lastError?.message
      if (runtimeError) {
        reject(new Error(runtimeError))
        return
      }

      if (!res?.ok) {
        reject(new Error(res?.error || 'Quick analysis request failed'))
        return
      }

      resolve(new Response(JSON.stringify(res.data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    })
  })
}

function isElementInViewport(element: HTMLElement): boolean {
  const host = element.closest<HTMLElement>('.AnswerItem, .List-item, .ContentItem, .AuthorInfo, .ProfileHeader') || element
  const rect = host.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1
  const visibleTop = Math.max(rect.top, 0)
  const visibleBottom = Math.min(rect.bottom, viewportHeight)
  const visibleLeft = Math.max(rect.left, 0)
  const visibleRight = Math.min(rect.right, viewportWidth)
  return visibleBottom > visibleTop && visibleRight > visibleLeft
}

function buildTagsFromDimensions(dimensions: SimpleAnalysisResult['dimensions'], riskScore: number): string[] {
  if (!dimensions) return [getSimpleRiskLevel(riskScore)]

  const tags = [
    { label: '议题集中', score: dimensions.topic_focus ?? 0, max: 20 },
    { label: '表达重复', score: dimensions.repetition ?? 0, max: 20 },
    { label: '商业植入', score: dimensions.commercial_intent ?? 0, max: 15 },
    { label: '情绪煽动', score: dimensions.emotional_manipulation ?? 0, max: 15 },
    { label: '活跃异常', score: dimensions.time_anomaly ?? 0, max: 10 },
    { label: '互动异常', score: dimensions.interaction_anomaly ?? 0, max: 10 },
    { label: '账号异常', score: dimensions.account_anomaly ?? 0, max: 10 },
  ]
    .map((item) => ({ ...item, ratio: item.max > 0 ? item.score / item.max : 0 }))
    .filter((item) => item.ratio > 0.5)
    .sort((a, b) => b.ratio - a.ratio || b.score - a.score)
    .slice(0, 5)
    .map((item) => item.label)

  return tags.length > 0 ? tags : [getSimpleRiskLevel(riskScore)]
}

function buildTagsFromAnalysisResult(result: AnalysisJsonResult): string[] {
  return buildTagsFromDimensions({
    topic_focus: result.dimensions.topic_focus?.score,
    repetition: result.dimensions.repetition?.score,
    commercial_intent: result.dimensions.commercial_intent?.score,
    emotional_manipulation: result.dimensions.emotional_manipulation?.score,
    time_anomaly: result.dimensions.time_anomaly?.score,
    interaction_anomaly: result.dimensions.interaction_anomaly?.score,
    account_anomaly: result.dimensions.account_anomaly?.score,
  }, result.total_score)
}

function normalizeRiskScore(value: unknown): number {
  const score = Number(value)
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(100, Math.round(score)))
}

function normalizeSimpleDimensions(value: unknown): SimpleAnalysisResult['dimensions'] | undefined {
  if (!isRecord(value)) return undefined
  return {
    topic_focus: normalizeDimensionScore(value.topic_focus),
    repetition: normalizeDimensionScore(value.repetition),
    commercial_intent: normalizeDimensionScore(value.commercial_intent),
    emotional_manipulation: normalizeDimensionScore(value.emotional_manipulation),
    time_anomaly: normalizeDimensionScore(value.time_anomaly),
    interaction_anomaly: normalizeDimensionScore(value.interaction_anomaly),
    account_anomaly: normalizeDimensionScore(value.account_anomaly),
  }
}

function normalizeDimensionScore(value: unknown): number {
  const score = Number(value)
  return Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function openSidePanel(target: AnalysisTarget, maxPages?: number) {
  chrome.runtime.sendMessage({ type: 'openSidePanel', target, maxPages }, (res) => {
    const runtimeError = chrome.runtime.lastError?.message
    if (runtimeError) {
      updateUserChips(target.userId, 'error', undefined, runtimeError)
      return
    }

    if (!res?.ok) {
      updateUserChips(target.userId, 'error', undefined, res?.error || '无法打开侧边栏')
    }
  })
}

function ensureStyle() {
  if (document.getElementById('zhihu-analyzer-style')) return

  const style = document.createElement('style')
  style.id = 'zhihu-analyzer-style'
  style.textContent = `
    @keyframes za-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(102, 126, 234, 0.35); }
      50% { box-shadow: 0 0 0 6px rgba(102, 126, 234, 0); }
    }

    .za-analyze-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 18px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
      animation: za-pulse 2s ease-in-out infinite;
    }

    .za-analyze-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .za-analyze-btn svg {
      width: 16px;
      height: 16px;
    }

    .za-user-tag {
      display: inline-flex;
      align-items: center;
      height: 20px;
      margin-left: 8px;
      padding: 0 7px;
      border: 1px solid #d0d7de;
      border-radius: 10px;
      background: #f6f8fa;
      color: #57606a;
      font-size: 12px;
      font-weight: 600;
      line-height: 18px;
      cursor: pointer;
      vertical-align: 1px;
      white-space: nowrap;
    }

    .za-user-tag:hover {
      border-color: #2f81f7;
      color: #0969da;
      background: #eef6ff;
    }

    .za-user-tag[data-status="loading"] {
      border-color: #8c959f;
      color: #57606a;
      cursor: wait;
    }

    .za-user-tag[data-risk="低风险"] {
      border-color: #2da44e;
      background: #dafbe1;
      color: #116329;
    }

    .za-user-tag[data-risk="中风险"] {
      border-color: #bf8700;
      background: #fff8c5;
      color: #7d4e00;
    }

    .za-user-tag[data-risk="高风险"],
    .za-user-tag[data-risk="极高风险"] {
      border-color: #cf222e;
      background: #ffebe9;
      color: #a40e26;
    }

    .za-user-tag[data-status="error"] {
      border-color: #cf222e;
      background: #ffebe9;
      color: #a40e26;
    }

    .za-analysis-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
      min-height: 22px;
    }

    .AuthorInfo-head + .za-analysis-row {
      margin-top: 4px;
    }

    .ProfileHeader-title .za-analysis-row {
      font-size: 14px;
      font-weight: 400;
      line-height: 1.4;
    }

    .za-avatar-tags {
      display: inline-flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      margin-left: 0;
      vertical-align: middle;
    }

    .za-avatar-tags:empty {
      display: none;
    }

    .za-avatar-tag {
      display: inline-flex;
      align-items: center;
      max-width: 76px;
      height: 18px;
      padding: 0 6px;
      border: 1px solid #d0d7de;
      border-radius: 9px;
      background: #f6f8fa;
      color: #57606a;
      font-size: 11px;
      font-weight: 600;
      line-height: 16px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .za-avatar-tag[data-risk="低风险"] {
      border-color: #2da44e;
      background: #dafbe1;
      color: #116329;
    }

    .za-avatar-tag[data-risk="中风险"] {
      border-color: #bf8700;
      background: #fff8c5;
      color: #7d4e00;
    }

    .za-avatar-tag[data-risk="高风险"],
    .za-avatar-tag[data-risk="极高风险"] {
      border-color: #cf222e;
      background: #ffebe9;
      color: #a40e26;
    }
  `
  document.head.appendChild(style)
}

function setChipState(chip: HTMLElement, status: ChipStatus, result?: AnalysisJsonResult, error?: string) {
  chip.dataset.status = status
  chip.dataset.risk = result?.risk_level || ''

  if (status === 'loading') {
    chip.hidden = false
    chip.textContent = '分析中'
    chip.title = '正在分析该用户'
    return
  }

  if (status === 'error') {
    chip.hidden = false
    chip.textContent = '分析失败'
    chip.title = error || '分析失败'
    return
  }

  if (result) {
    const tags = result.tags.length ? ` · ${result.tags.join(' / ')}` : ''
    chip.hidden = true
    chip.title = `${result.summary}${tags}`
    return
  }

  chip.hidden = false
  chip.textContent = '分析'
  chip.title = '分析这个知乎用户'
}

function updateUserChips(userId: string, status: ChipStatus, result?: AnalysisJsonResult, error?: string) {
  document.querySelectorAll<HTMLElement>(`.za-user-tag[data-user-id="${CSS.escape(userId)}"]`).forEach((chip) => {
    setChipState(chip, status, result, error)
  })
}

function setAvatarTagsState(container: HTMLElement, status: ChipStatus, result?: AnalysisJsonResult) {
  container.replaceChildren()
  container.dataset.status = status

  if (status !== 'done' || !result) return

  renderPageTags(container, {
    score: result.total_score,
    labels: buildTagsFromAnalysisResult(result),
    title: result.summary,
  })
}

function updateSimpleTags(userId: string, result: SimpleAnalysisResult) {
  document.querySelectorAll<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`).forEach((container) => {
    container.replaceChildren()
    container.dataset.status = 'done'

    renderPageTags(container, {
      score: result.risk_score,
      labels: result.tags,
      title: '简易分析',
    })
  })
}

function renderPageTags(container: HTMLElement, options: { score: number; labels: string[]; title?: string }) {
  const riskLevel = getSimpleRiskLevel(options.score)
  const scoreTag = document.createElement('span')
  scoreTag.className = 'za-avatar-tag'
  scoreTag.dataset.risk = riskLevel
  scoreTag.textContent = `${options.score}分`
  scoreTag.title = `风险分数 ${options.score}`
  container.appendChild(scoreTag)

  options.labels.slice(0, 5).forEach((label) => {
    const tag = document.createElement('span')
    tag.className = 'za-avatar-tag'
    tag.dataset.risk = riskLevel
    tag.textContent = label
    tag.title = options.title || label
    container.appendChild(tag)
  })
}

function getSimpleRiskLevel(score: number): RiskLevel {
  if (score >= 80) return '极高风险'
  if (score >= 60) return '高风险'
  if (score >= 35) return '中风险'
  return '低风险'
}

function updateUserAvatarTags(userId: string, status: ChipStatus, result?: AnalysisJsonResult) {
  document.querySelectorAll<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`).forEach((container) => {
    setAvatarTagsState(container, status, result)
  })
}

function getAnalysisRow(host: HTMLElement, userId: string): HTMLElement {
  let row = host.querySelector<HTMLElement>(`.za-analysis-row[data-user-id="${CSS.escape(userId)}"]`)
  if (!row) {
    row = document.createElement('div')
    row.className = 'za-analysis-row'
    row.dataset.userId = userId
  }
  return row
}

function ensureAvatarTags(nameWrap: HTMLElement, userId: string, result?: AnalysisJsonResult) {
  const authorContent = nameWrap.closest<HTMLElement>('.AuthorInfo-content')
  const authorHead = nameWrap.closest<HTMLElement>('.AuthorInfo-head')
  const authorInfo = authorContent?.parentElement || nameWrap.closest<HTMLElement>('.AuthorInfo')
  if (!authorInfo || !authorHead) return

  const row = getAnalysisRow(authorContent || authorInfo, userId)
  if (row.parentElement !== authorContent || authorHead.nextElementSibling !== row) {
    authorHead.after(row)
  }

  let container = authorInfo.querySelector<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`)
  if (!container) {
    container = document.createElement('span')
    container.className = 'za-avatar-tags'
    container.dataset.userId = userId
  }

  if (container.parentElement !== row || row.firstElementChild !== container) {
    row.prepend(container)
  }

  if (result) setAvatarTagsState(container, 'done', result)
  else {
    const simpleResult = simpleResultCache.get(userId)
    if (simpleResult) updateSimpleTags(userId, simpleResult)
  }
}

function ensureProfileAvatarTags(userId: string, result?: AnalysisJsonResult) {
  const title = document.querySelector<HTMLElement>('.ProfileHeader-title')
  if (!title) return

  const row = getAnalysisRow(title, userId)
  if (row.parentElement !== title) title.appendChild(row)

  let container = document.querySelector<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`)
  if (!container) {
    container = document.createElement('span')
    container.className = 'za-avatar-tags'
    container.dataset.userId = userId
  }

  if (container.parentElement !== row || row.firstElementChild !== container) {
    row.prepend(container)
  }

  if (result) setAvatarTagsState(container, 'done', result)
  else {
    const simpleResult = simpleResultCache.get(userId)
    if (simpleResult) updateSimpleTags(userId, simpleResult)
    else enqueueSimpleAnalysis({ userId, userName: getUserName() })
  }
}

function normalizeAuthorHead(authorHead: HTMLElement) {
  if (!isElementInViewport(authorHead)) return

  const nameWrap = authorHead.querySelector<HTMLElement>('.AuthorInfo-name')
  if (!nameWrap) return

  const nameLink = Array.from(nameWrap.querySelectorAll<HTMLAnchorElement>('a.UserLink-link'))
    .find((link) => Boolean(link.textContent?.trim()))
  if (!nameLink) return

  const userId = getUserIdFromHref(nameLink.href)
  const userName = nameLink.textContent?.trim()
  if (!userId || !userName) return
  const authorContent = authorHead.closest<HTMLElement>('.AuthorInfo-content') || authorHead.parentElement || authorHead

  authorContent.querySelectorAll<HTMLButtonElement>('.za-user-tag').forEach((candidate) => {
    if (candidate.dataset.userId !== userId) candidate.remove()
  })

  const chips = Array.from(authorContent.querySelectorAll<HTMLButtonElement>(`.za-user-tag[data-user-id="${CSS.escape(userId)}"]`))
  const chip = chips[0] || document.createElement('button')
  chips.slice(1).forEach((duplicate) => duplicate.remove())

  const cachedResult = resultCache.get(userId)
  const isNewChip = !chip.classList.contains('za-user-tag')

  if (isNewChip) {
    chip.type = 'button'
    chip.className = 'za-user-tag'
    chip.dataset.userId = userId
    chip.dataset.role = 'detail-analysis'
    setChipState(chip, 'idle', cachedResult)
    chip.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()

      updateUserChips(userId, 'loading')
      openSidePanel({ userId, userName }, getQuickAnalysisMaxPages())
    })
  }

  ensureAvatarTags(nameWrap, userId, cachedResult)
  const row = authorContent.querySelector<HTMLElement>(`.za-analysis-row[data-user-id="${CSS.escape(userId)}"]`)
  if (row && chip.parentElement !== row) row.appendChild(chip)
  enqueueSimpleAnalysis({ userId, userName })
}

function injectProfileButton() {
  ensureStyle()
  const userId = getUserId() || ''
  if (!userId) return

  ensureProfileAvatarTags(userId)
  const title = document.querySelector<HTMLElement>('.ProfileHeader-title')
  const row = title?.querySelector<HTMLElement>(`.za-analysis-row[data-user-id="${CSS.escape(userId)}"]`)
  if (!row) return

  const existing = row.querySelector<HTMLButtonElement>('#zhihu-analyzer-btn')
  if (existing) return

  const btn = document.createElement('button')
  btn.id = 'zhihu-analyzer-btn'
  btn.type = 'button'
  btn.innerHTML = `
    <span class="za-analyze-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>分析</span>
    </span>
  `
  btn.addEventListener('click', () => {
    const userId = getUserId() || ''
    const userName = getUserName()
    if (!userId) return

    ensureProfileAvatarTags(userId)
    updateUserAvatarTags(userId, 'loading')
    openSidePanel({ userId, userName })
  })

  row.appendChild(btn)
}

function injectQuestionAuthorTags() {
  if (!location.pathname.startsWith('/question/')) return

  ensureStyle()

  Array.from(document.querySelectorAll<HTMLElement>('.AuthorInfo-head'))
    .filter(isElementInViewport)
    .forEach(normalizeAuthorHead)
}

function inject() {
  if (location.pathname.startsWith('/people/')) injectProfileButton()
  injectQuestionAuthorTags()
}

let injectTimer: number | null = null
let scrollScheduleTimer: number | null = null

function shouldReactToMutations(mutations: MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
    return nodes.some((node) => {
      if (node instanceof HTMLElement) {
        return !node.matches('.za-analysis-row, .za-avatar-tags, .za-user-tag, .za-avatar-tag')
          && !node.closest('.za-analysis-row, .za-avatar-tags, .za-user-tag')
      }

      const parent = node.parentElement
      return parent ? !parent.closest('.za-analysis-row, .za-avatar-tags, .za-user-tag') : false
    })
  })
}

function setSimpleTagsStatus(userId: string, status: 'loading' | 'error') {
  document.querySelectorAll<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`).forEach((container) => {
    container.replaceChildren()
    container.dataset.status = status

    const tag = document.createElement('span')
    tag.className = 'za-avatar-tag'
    tag.textContent = status === 'loading' ? '简析中' : '简析失败'
    tag.title = status === 'loading' ? '正在进行简易分析' : '简易分析失败'
    container.appendChild(tag)
  })
}

function scheduleInject(mutations?: MutationRecord[]) {
  if (mutations && !shouldReactToMutations(mutations)) return
  if (injectTimer !== null) return
  injectTimer = window.setTimeout(() => {
    injectTimer = null
    inject()
  }, 400)
}

function scheduleVisibleQueueAnalysis() {
  if (simpleQueue.size === 0 || simpleAnalyzing || simpleAnalyzeTimer !== null || scrollScheduleTimer !== null) return
  scrollScheduleTimer = window.setTimeout(() => {
    scrollScheduleTimer = null
    scheduleSimpleAnalysis()
  }, 150)
}

const observer = new MutationObserver((mutations) => scheduleInject(mutations))
observer.observe(document.body, { childList: true, subtree: true })
window.addEventListener('scroll', () => {
  scheduleInject()
  scheduleVisibleQueueAnalysis()
}, { passive: true })
window.setTimeout(inject, SIMPLE_AUTO_START_DELAY_MS)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'fetchZhihuInPage') {
    fetch(msg.url, {
      method: 'GET',
      credentials: 'include',
      referrer: msg.referer || location.href,
      headers: {
        Accept: 'application/json',
        'x-requested-with': 'fetch',
      },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        return response.json()
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }

  if (msg.type === 'sidePanelAnalysisComplete') {
    const target = msg.target as AnalysisTarget
    const result = msg.result as AnalysisJsonResult
    resultCache.set(target.userId, result)
    updateUserChips(target.userId, 'done', result)
    updateUserAvatarTags(target.userId, 'done', result)
  }

  if (msg.type === 'sidePanelAnalysisError') {
    const target = msg.target as AnalysisTarget
    updateUserChips(target.userId, 'error', undefined, msg.error || '分析失败')
    updateUserAvatarTags(target.userId, 'error')
  }

  sendResponse?.({ ok: true })
  return false
})
