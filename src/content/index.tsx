import { fetchAnswers, getUserId, getUserName, getUserIdFromHref, summarizeAnswers } from '@/api/zhihu'
import type { AnalysisTarget, RiskLevel, SimpleAnalysisResult } from '@/types'
import { startDevReloader } from '@/devReload'
import { DEFAULT_FILTER_SETTINGS, loadFilterSettings, parseFilterSettingsChange, type FilterSettings } from '@/api/filterSettings'
import { getUserTypeLabel } from '@/api/userTypes'

startDevReloader('content')

type QuickAnalysisResponse = {
  success: boolean
  data?: Array<{
    platform_user_id: string
    risk_score: number
    risk_level: string
    user_type?: string
    tags?: string[]
    dimensions?: SimpleAnalysisResult['dimensions']
    cached?: boolean
  }>
}
type StatusError = Error & { status?: number }

const simpleResultCache = new Map<string, SimpleAnalysisResult>()
const simpleQueue = new Map<string, AnalysisTarget>()
const simpleInFlight = new Set<string>()
const simpleRetryCounts = new Map<string, number>()
let filterSettings: FilterSettings = DEFAULT_FILTER_SETTINGS
let simpleAnalyzeTimer: number | null = null
let simpleAnalyzing = false
const SIMPLE_BATCH_SIZE = 1
const SIMPLE_MAX_RETRIES = 1
const SIMPLE_AUTO_ANALYSIS_ENABLED = import.meta.env.VITE_ZHIHU_AUTO_QUICK_ANALYSIS !== 'false'
const SIMPLE_AUTO_START_DELAY_MS = getPositiveIntegerEnv('VITE_ZHIHU_AUTO_QUICK_ANALYSIS_DELAY_MS', 2000)
const SIMPLE_FETCH_TIMEOUT_MS = getPositiveIntegerEnv('VITE_ZHIHU_QUICK_ANALYSIS_TIMEOUT_MS', 12000)

function getQuickAnalysisMaxPages() {
  return getPositiveIntegerEnv('VITE_ZHIHU_QUICK_ANALYSIS_MAX_PAGES', 3)
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
    try {
      const cachedData = await withTimeout(
        quickAnalyzeInBackground({
          platform: 'zhihu',
          cache_only: true,
          users: targets.map((target) => ({
            platform_user_id: target.userId,
            user_name: target.userName,
          })),
        }),
        SIMPLE_FETCH_TIMEOUT_MS,
        'Quick analysis backend request timed out'
      )
      if (needsQuickAnalysisUpload(cachedData, targets)) {
        throw toStatusError('Quick analysis cache miss', 404)
      }
      applyQuickAnalysisData(cachedData, targets)
      return
    } catch (err) {
      if (!isStatusError(err, 404)) {
        console.warn('[Dominator] quick analysis cache lookup failed, falling back to live analysis', err)
      }
    }

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

    const data = await withTimeout(
      quickAnalyzeInBackground({
        platform: 'zhihu',
        cache_only: false,
        users: samples.map(({ target, answers }) => ({
          platform_user_id: target.userId,
          user_name: target.userName,
          answers,
        })),
      }),
      SIMPLE_FETCH_TIMEOUT_MS,
      'Quick analysis backend request timed out'
    )

    applyQuickAnalysisData(data, targets)
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

function applyQuickAnalysisData(data: QuickAnalysisResponse, targets: AnalysisTarget[]) {
  if (!data.success || !data.data) throw new Error('Backend returned invalid result')

  data.data.forEach((result, index) => {
    const target = targets.find((item) => item.userId === result.platform_user_id) || targets[index]
    if (!target) return

    const riskScore = normalizeRiskScore(result.risk_score)
    const dimensions = normalizeSimpleDimensions(result.dimensions)
    const userTypeLabel = getUserTypeLabel(result.user_type)
    const tags = Array.isArray(result.tags)
      ? result.tags.map(String).filter(Boolean)
      : buildTagsFromDimensions(dimensions)
    const displayTags = userTypeLabel
      ? [userTypeLabel, ...tags.filter((tag) => tag !== userTypeLabel)]
      : tags
    const normalized: SimpleAnalysisResult = {
      user_id: target.userId,
      risk_score: riskScore,
      user_type: result.user_type,
      dimensions,
      tags: displayTags.length > 0 ? displayTags : buildTagsFromDimensions(dimensions),
    }

    simpleResultCache.set(target.userId, normalized)
    simpleRetryCounts.delete(target.userId)
    updateSimpleTags(target.userId, normalized)
  })
}

function needsQuickAnalysisUpload(data: QuickAnalysisResponse, targets: AnalysisTarget[]) {
  if (!data.success || !data.data) return true
  return targets.some((target) => {
    const result = data.data?.find((item) => item.platform_user_id === target.userId)
    return !result || result.cached === false
  })
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

function quickAnalyzeInBackground(payload: unknown): Promise<QuickAnalysisResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'quickAnalyze', payload }, (res) => {
      const runtimeError = chrome.runtime.lastError?.message
      if (runtimeError) {
        reject(new Error(runtimeError))
        return
      }

      if (!res?.ok) {
        reject(toStatusError(res?.error || 'Quick analysis request failed', res?.status))
        return
      }

      resolve(res.data as QuickAnalysisResponse)
    })
  })
}

function toStatusError(message: string, status?: number): StatusError {
  const error = new Error(message) as StatusError
  error.status = status
  return error
}

function isStatusError(err: unknown, status: number): boolean {
  return err instanceof Error && (err as StatusError).status === status
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

function buildTagsFromDimensions(dimensions: SimpleAnalysisResult['dimensions']): string[] {
  if (!dimensions) return []

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

  return tags
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

function ensureStyle() {
  if (document.getElementById('zhihu-analyzer-style')) return

  const style = document.createElement('style')
  style.id = 'zhihu-analyzer-style'
  style.textContent = `
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
      margin-left: 6px;
      vertical-align: middle;
    }

    .za-avatar-tags:empty {
      display: none;
    }

    .za-loading-indicator {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 22px;
      flex: 0 0 auto;
    }

    .za-loading-indicator::before,
    .za-loading-indicator::after {
      content: '';
      position: absolute;
      inset: 1px 2px;
      border: 1px solid rgba(31, 136, 255, 0.55);
      border-radius: 999px;
      opacity: 0;
      animation: za-loading-ripple 1.45s ease-out infinite;
    }

    .za-loading-indicator::after {
      animation-delay: 0.45s;
    }

    .za-loading-icon {
      position: relative;
      z-index: 1;
      width: 24px;
      height: 24px;
      object-fit: contain;
      filter: drop-shadow(0 0 4px rgba(9, 218, 255, 0.55));
      animation: za-loading-pulse 1.45s ease-in-out infinite;
    }

    @keyframes za-loading-ripple {
      0% {
        transform: scale(0.72);
        opacity: 0.8;
      }
      100% {
        transform: scale(1.45);
        opacity: 0;
      }
    }

    @keyframes za-loading-pulse {
      0%, 100% {
        transform: translateY(0) scale(0.96);
        opacity: 0.85;
      }
      50% {
        transform: translateY(-1px) scale(1.04);
        opacity: 1;
      }
    }

    .za-author-name-with-tags {
      display: inline-flex !important;
      align-items: center;
      gap: 6px;
    }

    .za-author-name-with-tags .za-avatar-tags {
      margin-left: 0;
    }

    .za-hover-tags {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
      min-height: 18px;
    }

    .za-hover-tags:empty {
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

    .za-filter-placeholder {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: 100%;
      min-height: 48px;
      margin: 8px 0;
      padding: 10px 14px;
      border: 1px solid #d8dee4;
      border-radius: 8px;
      background: #f6f8fa;
      color: #57606a;
      font-size: 14px;
      line-height: 1.4;
    }

    .za-filter-placeholder-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .za-filter-expand-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid #8c959f;
      border-radius: 6px;
      background: #ffffff;
      color: #24292f;
      cursor: pointer;
    }

    .za-filter-expand-button:hover {
      border-color: #57606a;
      background: #f3f4f6;
    }

    .za-filter-expand-button svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
    }
  `
  document.head.appendChild(style)
}

function updateSimpleTags(userId: string, result: SimpleAnalysisResult) {
  document.querySelectorAll<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`).forEach((container) => {
    container.replaceChildren()
    container.dataset.status = 'done'

    renderLabelTags(container, {
      score: result.risk_score,
      labels: getPrimaryLabels(result),
      title: '简易分析',
    })
  })
  updateHoverTags(userId, result)
  applyUserFilter(userId, result)
}

function updateHoverTags(userId: string, result: SimpleAnalysisResult) {
  document.querySelectorAll<HTMLElement>(`.za-hover-tags[data-user-id="${CSS.escape(userId)}"]`).forEach((container) => {
    container.replaceChildren()
    container.dataset.status = 'done'

    renderLabelTags(container, {
      score: result.risk_score,
      labels: getHoverLabels(result),
      title: '简易分析',
    })
  })
}

function renderLabelTags(container: HTMLElement, options: { score: number; labels: string[]; title?: string }) {
  const riskLevel = getSimpleRiskLevel(options.score)
  options.labels.slice(0, 5).forEach((label) => {
    const tag = document.createElement('span')
    tag.className = 'za-avatar-tag'
    tag.dataset.risk = riskLevel
    tag.textContent = label
    tag.title = options.title || label
    container.appendChild(tag)
  })
}

function getPrimaryLabels(result: SimpleAnalysisResult): string[] {
  const userTypeLabel = getUserTypeLabel(result.user_type)
  return userTypeLabel ? [userTypeLabel] : []
}

function getHoverLabels(result: SimpleAnalysisResult): string[] {
  const userTypeLabel = getUserTypeLabel(result.user_type)
  return result.tags.filter((label) => label && label !== userTypeLabel)
}

function shouldCollapseUser(result: SimpleAnalysisResult): boolean {
  return Boolean(result.user_type && filterSettings.blockedUserTypes.includes(result.user_type))
}

function applyAllUserFilters() {
  simpleResultCache.forEach((result, userId) => applyUserFilter(userId, result))
}

function applyUserFilter(userId: string, result: SimpleAnalysisResult) {
  const shouldCollapse = shouldCollapseUser(result)
  const label = getUserTypeLabel(result.user_type) || result.user_type || '当前类型用户'

  findUserContentHosts(userId).forEach((host) => {
    host.dataset.zaFilterUserId = userId
    if (shouldCollapse && host.dataset.zaFilterExpanded !== 'true') {
      collapseUserHost(host, userId, label)
      return
    }

    restoreUserHost(host)
  })
}

function findUserContentHosts(userId: string): HTMLElement[] {
  const hosts = new Set<HTMLElement>()

  document.querySelectorAll<HTMLAnchorElement>('a.UserLink-link[href*="/people/"]').forEach((link) => {
    if (getUserIdFromHref(link.href) !== userId) return

    const host = getFilterHostForUserLink(link)
    if (host) hosts.add(host)
  })

  return Array.from(hosts)
}

function getFilterHostForUserLink(link: HTMLAnchorElement): HTMLElement | null {
  if (isFloatingHoverCard(link) || link.closest('.ProfileHeader')) return null
  if (!link.closest('.AuthorInfo-head')) return null

  const host = link.closest<HTMLElement>('.List-item')
    || link.closest<HTMLElement>('.AnswerItem')
    || link.closest<HTMLElement>('.ContentItem')
  if (!host) return null

  if (!host.querySelector('.RichContent, .ContentItem-actions')) return null
  return host
}

function collapseUserHost(host: HTMLElement, userId: string, label: string) {
  const placeholder = ensureFilterPlaceholder(host)
  placeholder.dataset.userId = userId

  const text = document.createElement('span')
  text.className = 'za-filter-placeholder-text'
  text.textContent = label

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'za-filter-expand-button'
  button.title = '展开'
  button.setAttribute('aria-label', '展开')
  button.appendChild(createExpandIcon())
  button.addEventListener('click', () => {
    host.dataset.zaFilterExpanded = 'true'
    restoreUserHost(host)
  })

  placeholder.replaceChildren(text, button)
  if (!host.dataset.zaFilterPreviousDisplay) {
    host.dataset.zaFilterPreviousDisplay = host.style.display || '__empty__'
  }
  host.style.display = 'none'
}

function createExpandIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')

  const paths = [
    'M8 3H5a2 2 0 0 0-2 2v3',
    'M16 3h3a2 2 0 0 1 2 2v3',
    'M8 21H5a2 2 0 0 1-2-2v-3',
    'M16 21h3a2 2 0 0 0 2-2v-3',
    'M9 9l-4-4',
    'M15 9l4-4',
    'M9 15l-4 4',
    'M15 15l4 4',
  ]

  paths.forEach((value) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', value)
    svg.appendChild(path)
  })

  return svg
}

function ensureFilterPlaceholder(host: HTMLElement): HTMLElement {
  const existing = getFilterPlaceholder(host)
  if (existing) {
    if (existing.nextElementSibling !== host) host.before(existing)
    return existing
  }

  const placeholder = document.createElement('div')
  placeholder.className = 'za-filter-placeholder'
  host.before(placeholder)
  return placeholder
}

function getFilterPlaceholder(host: HTMLElement): HTMLElement | null {
  const previous = host.previousElementSibling
  if (previous instanceof HTMLElement && previous.classList.contains('za-filter-placeholder')) return previous
  return null
}

function restoreUserHost(host: HTMLElement) {
  const previousDisplay = host.dataset.zaFilterPreviousDisplay
  if (previousDisplay === '__empty__') host.style.removeProperty('display')
  else if (previousDisplay) host.style.display = previousDisplay
  else host.style.removeProperty('display')

  delete host.dataset.zaFilterPreviousDisplay
  getFilterPlaceholder(host)?.remove()
}

function getSimpleRiskLevel(score: number): RiskLevel {
  if (score >= 80) return '极高风险'
  if (score >= 60) return '高风险'
  if (score >= 35) return '中风险'
  return '低风险'
}

function removeEmptyAnalysisRow(row: HTMLElement | null) {
  if (row && row.childElementCount === 0) row.remove()
}

function ensureAvatarTags(nameWrap: HTMLElement, userId: string) {
  const authorContent = nameWrap.closest<HTMLElement>('.AuthorInfo-content')
  const authorHead = nameWrap.closest<HTMLElement>('.AuthorInfo-head')
  const authorInfo = authorContent?.parentElement || nameWrap.closest<HTMLElement>('.AuthorInfo')
  if (!authorInfo || !authorHead) return

  const row = authorInfo.querySelector<HTMLElement>(`.za-analysis-row[data-user-id="${CSS.escape(userId)}"]`)

  let container = authorInfo.querySelector<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`)
  if (!container) {
    container = document.createElement('span')
    container.className = 'za-avatar-tags'
    container.dataset.userId = userId
  }

  if (container.parentElement !== nameWrap) {
    nameWrap.appendChild(container)
  }
  nameWrap.classList.add('za-author-name-with-tags')
  removeEmptyAnalysisRow(row)

  const simpleResult = simpleResultCache.get(userId)
  if (simpleResult) updateSimpleTags(userId, simpleResult)
}

function ensureProfileAvatarTags(userId: string) {
  const title = document.querySelector<HTMLElement>('.ProfileHeader-title')
  if (!title) return

  const row = title.querySelector<HTMLElement>(`.za-analysis-row[data-user-id="${CSS.escape(userId)}"]`)

  let container = title.querySelector<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`)
  if (!container) {
    container = document.createElement('span')
    container.className = 'za-avatar-tags'
    container.dataset.userId = userId
  }

  if (container.parentElement !== title) {
    title.appendChild(container)
  }
  removeEmptyAnalysisRow(row)

  const simpleResult = simpleResultCache.get(userId)
  if (simpleResult) updateSimpleTags(userId, simpleResult)
  else enqueueSimpleAnalysis({ userId, userName: getUserName() })
}

function ensureHoverCardTags() {
  removeDetachedHoverTags()

  const cards = getUserHoverCards()
  cards.forEach((card) => {
    const nameLink = getHoverCardNameLink(card)
    if (!nameLink) return

    const userId = getUserIdFromHref(nameLink.href)
    const userName = nameLink.textContent?.trim()
    if (!userId || !userName) return

    let container = card.querySelector<HTMLElement>(`.za-hover-tags[data-user-id="${CSS.escape(userId)}"]`)
    if (!container) {
      container = document.createElement('div')
      container.className = 'za-hover-tags'
      container.dataset.userId = userId
    }

    const anchor = getHoverCardTagAnchor(nameLink)
    if (container.parentElement !== anchor.parentElement || container.previousElementSibling !== anchor) {
      anchor.after(container)
    }

    const simpleResult = simpleResultCache.get(userId)
    if (simpleResult) updateHoverTags(userId, simpleResult)
    else enqueueSimpleAnalysis({ userId, userName })
  })
}

function getUserHoverCards(): HTMLElement[] {
  const cards = new Set<HTMLElement>()

  document.querySelectorAll<HTMLAnchorElement>('a.UserLink-link[href*="/people/"]').forEach((link) => {
    if (!isUserHomeLink(link.href) || !link.textContent?.trim()) return

    const card = getHoverCardRoot(link)
    if (card) cards.add(card)
  })

  return Array.from(cards)
}

function getHoverCardRoot(nameLink: HTMLAnchorElement): HTMLElement | null {
  let element = nameLink.parentElement
  while (element && element !== document.body) {
    if (element.querySelector('.NumberBoard') && element.querySelector('.HoverCard-buttons, .MemberButtonGroup')) {
      return isFloatingHoverCard(element) ? element : null
    }
    element = element.parentElement
  }
  return null
}

function removeDetachedHoverTags() {
  document.querySelectorAll<HTMLElement>('.za-hover-tags').forEach((container) => {
    if (!isFloatingHoverCard(container)) container.remove()
  })
}

function isFloatingHoverCard(element: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current)
    if (style.position === 'absolute' || style.position === 'fixed') return true
    current = current.parentElement
  }
  return false
}

function getHoverCardNameLink(card: HTMLElement): HTMLAnchorElement | null {
  return Array.from(card.querySelectorAll<HTMLAnchorElement>('a.UserLink-link[href*="/people/"]'))
    .find((link) => Boolean(link.textContent?.trim()) && isUserHomeLink(link.href)) || null
}

function getHoverCardTagAnchor(nameLink: HTMLAnchorElement): HTMLElement {
  const userLink = nameLink.closest<HTMLElement>('.UserLink')
  const titleBlock = userLink?.parentElement?.parentElement
  return nameLink.closest<HTMLElement>('.HoverCard-title, .MemberCard-name')
    || titleBlock
    || userLink
    || nameLink.parentElement
    || nameLink
}

function isUserHomeLink(href: string): boolean {
  try {
    const path = new URL(href, location.origin).pathname
    return /^\/people\/[^/]+\/?$/.test(path)
  } catch {
    return false
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

  ensureAvatarTags(nameWrap, userId)
  enqueueSimpleAnalysis({ userId, userName })
}

function injectProfileTags() {
  ensureStyle()
  const userId = getUserId() || ''
  if (!userId) return

  ensureProfileAvatarTags(userId)
}

function injectQuestionAuthorTags() {
  if (!location.pathname.startsWith('/question/')) return

  ensureStyle()

  Array.from(document.querySelectorAll<HTMLElement>('.AuthorInfo-head'))
    .filter(isElementInViewport)
    .forEach(normalizeAuthorHead)
}

function inject() {
  if (location.pathname.startsWith('/people/')) injectProfileTags()
  injectQuestionAuthorTags()
  ensureHoverCardTags()
}

let injectTimer: number | null = null
let scrollScheduleTimer: number | null = null

function shouldReactToMutations(mutations: MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
    return nodes.some((node) => {
      if (node instanceof HTMLElement) {
        return !node.matches('.za-analysis-row, .za-avatar-tags, .za-hover-tags, .za-avatar-tag, .za-filter-placeholder')
          && !node.closest('.za-analysis-row, .za-avatar-tags, .za-hover-tags, .za-filter-placeholder')
      }

      const parent = node.parentElement
      return parent ? !parent.closest('.za-analysis-row, .za-avatar-tags, .za-hover-tags, .za-filter-placeholder') : false
    })
  })
}

function setSimpleTagsStatus(userId: string, status: 'loading' | 'error') {
  document.querySelectorAll<HTMLElement>(`.za-avatar-tags[data-user-id="${CSS.escape(userId)}"]`).forEach((container) => {
    container.replaceChildren()
    container.dataset.status = status

    if (status === 'loading') {
      renderLoadingIndicator(container)
      return
    }
  })
}

function renderLoadingIndicator(container: HTMLElement) {
  const indicator = document.createElement('span')
  indicator.className = 'za-loading-indicator'
  indicator.title = '正在进行简易分析'

  const icon = document.createElement('img')
  icon.className = 'za-loading-icon'
  icon.alt = ''
  icon.decoding = 'async'
  icon.src = chrome.runtime.getURL('icons/dominator-loading.png')

  indicator.appendChild(icon)
  container.appendChild(indicator)
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

function initializeFilterSettings() {
  loadFilterSettings()
    .then((settings) => {
      filterSettings = settings
      applyAllUserFilters()
      scheduleInject()
    })
    .catch((err) => {
      console.warn('[Dominator] failed to load filter settings', err)
    })

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return

    const settings = parseFilterSettingsChange(changes)
    if (!settings) return

    filterSettings = settings
    applyAllUserFilters()
  })
}

const observer = new MutationObserver((mutations) => scheduleInject(mutations))
observer.observe(document.body, { childList: true, subtree: true })
window.addEventListener('scroll', () => {
  scheduleInject()
  scheduleVisibleQueueAnalysis()
}, { passive: true })
initializeFilterSettings()
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

  sendResponse?.({ ok: true })
  return false
})
