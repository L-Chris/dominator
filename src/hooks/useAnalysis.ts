import { useState, useCallback } from 'react'
import { fetchArticles, fetchAnswers, getUserName, getUserId } from '@/api/zhihu'
import { getConfig } from '@/api/storage'
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
      step: '正在获取数据...',
      error: null,
      result: null,
      articleCount: 0,
      answerCount: 0,
      target: analysisTarget,
    })

    try {
      const maxPages = options?.maxPages ?? getDefaultMaxPages()
      const answers = await fetchAnswers(maxPages, analysisTarget.userId, options?.tabId)
      const articles = await fetchArticles(maxPages, analysisTarget.userId, options?.tabId)

      setState((prev) => ({
        ...prev,
        articleCount: articles.length,
        answerCount: answers.length,
        step: '正在发送数据到后端分析...',
      }))

      const config = await getConfig()
      if (!config.serviceUrl) {
        throw new Error('请先在插件设置页面配置后端服务地址')
      }

      const serviceUrl = config.serviceUrl.replace(/\/+$/, '')
      const response = await fetch(`${serviceUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platformUserId: analysisTarget.userId,
          userName: analysisTarget.userName,
          articles,
          answers,
        }),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`后端返回 ${response.status}: ${text.slice(0, 300)}`)
      }

      const json = await response.json() as {
        success: boolean
        data?: {
          riskLevel: string
          totalScore: number
          summary: string
          tags: unknown
          dimensions: unknown
          evidence: unknown
        }
      }

      if (!json.success || !json.data) {
        throw new Error('后端未返回有效结果')
      }

      const result: AnalysisJsonResult = {
        risk_level: json.data.riskLevel as AnalysisJsonResult['risk_level'],
        total_score: json.data.totalScore,
        summary: json.data.summary,
        tags: Array.isArray(json.data.tags) ? json.data.tags.map(String) : [],
        dimensions: json.data.dimensions as AnalysisJsonResult['dimensions'],
        evidence: Array.isArray(json.data.evidence) ? json.data.evidence.map(String) : [],
      }

      const resultText = formatAnalysisAsMarkdown(result)

      setState((prev) => ({
        ...prev,
        loading: false,
        step: '',
        result: resultText,
      }))
      options?.onComplete?.(result)
    } catch (err) {
      const error = err instanceof Error ? err.message : '分析失败'
      setState((prev) => ({
        ...prev,
        loading: false,
        step: '',
        error,
      }))
      options?.onError?.(error)
    }
  }, [])

  return { ...state, analyze }
}
