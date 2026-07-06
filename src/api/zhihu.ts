import type { Article, Answer, ZhihuApiResponse, ArticleSummary, AnswerSummary } from '@/types'

const PAGE_SIZE = 20
const ARTICLE_INCLUDE = [
  'data[*].title',
  'excerpt',
  'comment_count',
  'suggest_edit',
  'is_normal',
  'voteup_count',
  'created',
  'is_labeled',
].join(',')
const ANSWER_INCLUDE = [
  'data[*].is_normal',
  'is_collapsed',
  'suggest_edit',
  'comment_count',
  'voteup_count',
  'created_time',
  'excerpt',
  'is_labeled',
  'question.title',
].join(',')

function sendFetch<T>(url: string, referer?: string, tabId?: number): Promise<{ ok: boolean; data?: ZhihuApiResponse<T> }> {
  if (tabId === undefined && isZhihuPageContext()) {
    return fetchZhihuInPage<T>(url, referer)
  }

  return new Promise((resolve) => {
    const type = tabId === undefined ? 'fetchZhihu' : 'fetchZhihuFromTab'
    chrome.runtime.sendMessage({ type, url, referer, tabId }, (res) => {
      resolve(res ?? { ok: false })
    })
  })
}

async function fetchZhihuInPage<T>(url: string, referer?: string): Promise<{ ok: boolean; data?: ZhihuApiResponse<T> }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      referrer: referer || location.href,
      headers: {
        Accept: 'application/json',
        'x-requested-with': 'fetch',
      },
    })
    if (!response.ok) return { ok: false }
    return { ok: true, data: await response.json() }
  } catch {
    return { ok: false }
  }
}

function isZhihuPageContext(): boolean {
  return typeof location !== 'undefined'
    && location.protocol === 'https:'
    && (location.hostname === 'www.zhihu.com' || location.hostname.endsWith('.zhihu.com'))
}

export async function fetchArticles(maxPages = 5, targetUserId = getUserId(), tabId?: number): Promise<Article[]> {
  if (!targetUserId) return []

  const allItems: Article[] = []
  let nextUrl = `https://www.zhihu.com/api/v4/members/${targetUserId}/articles?include=${encodeURIComponent(ARTICLE_INCLUDE)}&offset=0&limit=${PAGE_SIZE}&sort_by=created&ws_qiangzhisafe=0`
  let effectiveMaxPages = maxPages

  for (let i = 0; i < effectiveMaxPages; i++) {
    const res = await sendFetch<Article>(nextUrl, `https://www.zhihu.com/people/${targetUserId}/posts`, tabId)
    if (!res?.ok || !res.data?.data) break
    allItems.push(...(res.data.data as Article[]))
    effectiveMaxPages = getEffectiveMaxPages(effectiveMaxPages, res.data)
    if (res.data.paging?.is_end) break
    if (!res.data.paging?.next) break
    nextUrl = res.data.paging.next.replace(/^http:/, 'https:')
  }
  return allItems
}

export async function fetchAnswers(maxPages = 5, targetUserId = getUserId(), tabId?: number): Promise<Answer[]> {
  if (!targetUserId) return []
  if (maxPages <= 0) return []

  const allItems: Answer[] = []
  const seenIds = new Set<string>()

  const firstUrl = buildAnswersUrl(targetUserId, 0)
  debugFetchAnswers(targetUserId, 1, maxPages, firstUrl, allItems.length)
  const firstRes = await sendFetch<Answer>(firstUrl, `https://www.zhihu.com/people/${targetUserId}/answers`, tabId)
  if (!firstRes?.ok || !firstRes.data?.data) return allItems

  appendUniqueAnswers(allItems, seenIds, firstRes.data.data as Answer[])

  const effectiveMaxPages = getEffectiveMaxPages(maxPages, firstRes.data)
  if (firstRes.data.paging?.is_end || effectiveMaxPages <= 1) return allItems

  const remainingRequests = Array.from({ length: effectiveMaxPages - 1 }, (_, index) => {
    const page = index + 2
    const url = buildAnswersUrl(targetUserId, (page - 1) * PAGE_SIZE)
    debugFetchAnswers(targetUserId, page, effectiveMaxPages, url, allItems.length)
    return sendFetch<Answer>(url, `https://www.zhihu.com/people/${targetUserId}/answers`, tabId)
  })

  const remainingResponses = await Promise.all(remainingRequests)
  remainingResponses.forEach((res) => {
    if (!res?.ok || !res.data?.data) return
    appendUniqueAnswers(allItems, seenIds, res.data.data as Answer[])
  })

  return allItems
}

function buildAnswersUrl(targetUserId: string, offset: number): string {
  return `https://www.zhihu.com/api/v4/members/${targetUserId}/answers?include=${encodeURIComponent(ANSWER_INCLUDE)}&offset=${offset}&limit=${PAGE_SIZE}&sort_by=created&ws_qiangzhisafe=0`
}

function appendUniqueAnswers(allItems: Answer[], seenIds: Set<string>, answers: Answer[]) {
  for (const answer of answers) {
    const answerId = String(answer.id)
    if (seenIds.has(answerId)) continue
    seenIds.add(answerId)
    allItems.push(answer)
  }
}

function debugFetchAnswers(targetUserId: string, page: number, maxPages: number, url: string, loadedCount: number) {
  if (!import.meta.env.DEV) return
  const parsed = new URL(url)
  console.info('[Dominator] fetch answers page', {
    targetUserId,
    page,
    maxPages,
    offset: parsed.searchParams.get('offset'),
    limit: parsed.searchParams.get('limit'),
    loadedCount,
  })
}

function getEffectiveMaxPages<T>(configuredMaxPages: number, response: ZhihuApiResponse<T>): number {
  const totals = response.paging?.totals ?? response.totals
  if (!Number.isFinite(totals) || totals === undefined) return configuredMaxPages
  const totalPages = Math.ceil(totals / PAGE_SIZE)
  return Math.max(1, Math.min(configuredMaxPages, totalPages))
}

export function summarizeArticles(articles: Article[]): ArticleSummary[] {
  return articles.map((a) => ({
    title: a.title,
    created: new Date(a.created * 1000).toISOString(),
    updated: a.updated ? new Date(a.updated * 1000).toISOString() : '',
    voteup_count: toNumber(a.voteup_count),
    comment_count: toNumber(a.comment_count),
    suggest_edit: Boolean(a.suggest_edit),
    is_normal: a.is_normal !== false,
    content_preview: cleanContentPreview(a.excerpt || a.content || ''),
    label: a.label_info?.text || '',
    is_labeled: a.is_labeled,
    reaction: a.reaction_instruction?.text || '',
  }))
}

export function summarizeAnswers(answers: Answer[]): AnswerSummary[] {
  return answers.map((a) => ({
    question_title: a.question?.title || '未知问题',
    created: new Date(a.created_time * 1000).toISOString(),
    updated: a.updated_time ? new Date(a.updated_time * 1000).toISOString() : '',
    voteup_count: toNumber(a.voteup_count),
    comment_count: toNumber(a.comment_count),
    suggest_edit: Boolean(a.suggest_edit),
    is_normal: a.is_normal !== false,
    is_collapsed: Boolean(a.is_collapsed),
    content_preview: cleanContentPreview(a.excerpt || a.content || ''),
    label: a.label_info?.text || '',
    is_labeled: a.is_labeled,
    reaction: a.reaction_instruction?.text || '',
  }))
}

function toNumber(value: unknown): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : 0
}

function cleanContentPreview(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\[(?:图片|图|视频|动图|表情)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

export function getUserId(): string | null {
  const m = location.pathname.match(/\/people\/([^/]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

export function getUserName(): string {
  const el = document.querySelector('.ProfileHeader-name')
  return el?.textContent?.trim() || getUserId() || '未知用户'
}

export function getUserIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, location.origin)
    const m = url.pathname.match(/\/people\/([^/]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}
