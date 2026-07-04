import { useState, useCallback } from 'react'
import { fetchArticles, fetchAnswers, getUserName, getUserId } from '@/api/zhihu'
import { SERVICE_URL } from '@/api/storage'
import type { AnalysisJsonResult, AnalysisTarget } from '@/types'

interface AnalyzeOptions {
  maxPages?: number
  tabId?: number
  onComplete?: (result: AnalysisJsonResult) => void
  onError?: (error: string) => void
}

interface AnalysisState {
  loading: boolean
  step: string
  error: string | null
  result: string | null
  articleCount: number
  answerCount: number
  target: AnalysisTarget | null
}

function getDefaultMaxPages(): number {
  const configured = Number(import.meta.env.VITE_ZHIHU_ANALYSIS_MAX_PAGES || 5)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 5
}

function formatAnalysisAsMarkdown(r: AnalysisJsonResult): string {
  const dimNames = {
    topic_focus: '主题集中度 (20)',
    repetition: '内容重复度 (20)',
    commercial_intent: '商业植入 (15)',
    emotional_manipulation: '情绪操控 (15)',
    time_anomaly: '时间异常 (10)',
    interaction_anomaly: '互动异常 (10)',
    account_anomaly: '账号画像异常 (10)',
  }
  const dimLines = (Object.keys(dimNames) as Array<keyof typeof dimNames>)
    .map((k) => `- **${dimNames[k]}**: ${r.dimensions[k].score}/${k === 'topic_focus' || k === 'repetition' ? 20 : k === 'commercial_intent' || k === 'emotional_manipulation' ? 15 : 10} — ${r.dimensions[k].evidence}`)
    .join('\n')

  return `### 结论：${r.risk_level}（总分 ${r.total_score}/100）

${r.summary}

### 维度评分
${dimLines}

### 关键证据
${r.evidence.map((e) => `- ${e}`).join('\n')}

**标签**: ${r.tags.join(', ')}`
}

export function useAnalysis() {
  const [state, setState] = useState<AnalysisState>({
    loading: false,
    step: '',
    error: null,
    result: null,
    articleCount: 0,
    answerCount: 0,
    target: null,
  })

  const analyze = useCallback(async (target?: AnalysisTarget, options?: AnalyzeOptions) => {
    const analysisTarget = target || {
      userName: getUserName(),
      userId: getUserId() || '',
    }

    setState({
      loading: true,
      step: '正在查询缓存...',
      error: null,
      result: null,
      articleCount: 0,
      answerCount: 0,
      target: analysisTarget,
    })

    const serviceUrl = SERVICE_URL.replace(/\/+$/, '')

    // Helper: POST to backend and parse response
    const callBackend = async (body: Record<string, unknown>) => {
      const response = await fetch(`${serviceUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`后端返回 ${response.status}: ${text.slice(0, 300)}`)
      }

      const json = await response.json() as {
        success: boolean
        cached?: boolean
        data?: {
          risk_level: string
          total_score: number
          user_type?: string
          summary: string
          tags: unknown
          dimensions: unknown
          evidence: unknown
          article_count?: number
          answer_count?: number
        }
      }

      if (!json.success || !json.data) {
        throw new Error('后端未返回有效结果')
      }

      const result: AnalysisJsonResult = {
        risk_level: json.data.risk_level as AnalysisJsonResult['risk_level'],
        total_score: json.data.total_score,
        user_type: json.data.user_type,
        summary: json.data.summary,
        tags: Array.isArray(json.data.tags) ? json.data.tags.map(String) : [],
        dimensions: json.data.dimensions as AnalysisJsonResult['dimensions'],
        evidence: Array.isArray(json.data.evidence) ? json.data.evidence.map(String) : [],
      }

      return { result, cached: json.cached === true, articleCount: json.data.article_count ?? 0, answerCount: json.data.answer_count ?? 0 }
    }

    const finishWith = (result: AnalysisJsonResult, articleCount: number, answerCount: number) => {
      const resultText = formatAnalysisAsMarkdown(result)
      setState((prev) => ({ ...prev, loading: false, step: '', result: resultText, articleCount, answerCount }))
      options?.onComplete?.(result)
    }

    try {
      // Step 1: Check cache (no data)
      try {
        const { result, articleCount, answerCount } = await callBackend({
          platform: 'zhihu',
          platform_user_id: analysisTarget.userId,
          user_name: analysisTarget.userName,
          cache_only: true,
        })
        finishWith(result, articleCount, answerCount)
        return
      } catch (err) {
        // 404 means no cached result, proceed to fetch
        const msg = err instanceof Error ? err.message : ''
        if (!msg.includes('404')) {
          throw err
        }
      }

      // Step 2: Fetch from Zhihu
      setState((prev) => ({ ...prev, step: '正在获取数据...' }))
      const maxPages = options?.maxPages ?? getDefaultMaxPages()
      const answers = await fetchAnswers(maxPages, analysisTarget.userId, options?.tabId)
      const articles = await fetchArticles(maxPages, analysisTarget.userId, options?.tabId)

      setState((prev) => ({
        ...prev,
        articleCount: articles.length,
        answerCount: answers.length,
        step: '正在发送数据到后端分析...',
      }))

      // Step 3: Send data and analyze
      const { result } = await callBackend({
        platform: 'zhihu',
        platform_user_id: analysisTarget.userId,
        user_name: analysisTarget.userName,
        cache_only: false,
        articles,
        answers,
      })
      finishWith(result, articles.length, answers.length)
    } catch (err) {
      const error = err instanceof Error ? err.message : '分析失败'
      setState((prev) => ({ ...prev, loading: false, step: '', error }))
      options?.onError?.(error)
    }
  }, [])

  return { ...state, analyze }
}
