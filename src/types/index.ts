export type RiskLevel = '低风险' | '中风险' | '高风险' | '极高风险' | '未知'

export interface AnalysisJsonResult {
  risk_level: RiskLevel
  total_score: number
  user_type?: string
  summary: string
  tags: string[]
  dimensions: {
    topic_focus: { score: number; evidence: string }
    repetition: { score: number; evidence: string }
    commercial_intent: { score: number; evidence: string }
    emotional_manipulation: { score: number; evidence: string }
    time_anomaly: { score: number; evidence: string }
    interaction_anomaly: { score: number; evidence: string }
    account_anomaly: { score: number; evidence: string }
  }
  evidence: string[]
}

export interface SimpleAnalysisResult {
  user_id: string
  risk_score: number
  user_type?: string
  dimensions?: {
    topic_focus?: number
    repetition?: number
    commercial_intent?: number
    emotional_manipulation?: number
    time_anomaly?: number
    interaction_anomaly?: number
    account_anomaly?: number
  }
  tags: string[]
}

export interface AnalysisTarget {
  userId: string
  userName: string
}

export interface SidePanelAnalysisRequest {
  requestId: string
  target: AnalysisTarget
  maxPages?: number
  tabId?: number
}

export interface Article {
  id: string
  title: string
  created: number
  updated?: number
  voteup_count: number
  comment_count: number
  content?: string
  excerpt?: string
  is_normal: boolean
  suggest_edit: boolean
  is_labeled: boolean
  label_info?: { text?: string }
  reaction_instruction?: { text?: string }
}

export interface Answer {
  id: number
  created_time: number
  updated_time?: number
  voteup_count: number
  comment_count: number
  content?: string
  excerpt: string
  is_normal: boolean
  suggest_edit: boolean
  is_collapsed: boolean
  is_labeled: boolean
  label_info?: { text?: string }
  reaction_instruction?: { text?: string }
  thanks_count: number
  question?: { title?: string }
}

export interface ZhihuPaging {
  is_end: boolean
  next?: string
  totals?: number
}

export interface ZhihuApiResponse<T> {
  data: T[]
  paging: ZhihuPaging
  totals?: number
}

export interface ArticleSummary {
  title: string
  created: string
  updated: string
  voteup_count: number
  comment_count: number
  suggest_edit: boolean
  is_normal: boolean
  content_preview: string
  label: string
  is_labeled: boolean
  reaction: string
}

export interface AnswerSummary {
  question_title: string
  created: string
  updated: string
  voteup_count: number
  comment_count: number
  suggest_edit: boolean
  is_normal: boolean
  is_collapsed: boolean
  content_preview: string
  label: string
  is_labeled: boolean
  reaction: string
}

export interface AnalysisResult {
  text: string
}

export type MessageToBackground =
  | { type: 'fetchZhihu'; url: string; referer?: string }
  | { type: 'fetchZhihuFromTab'; url: string; referer?: string; tabId?: number }
  | { type: 'quickAnalyze'; payload: unknown }
  | { type: 'enableSidePanelForCurrentTab' }
  | { type: 'openSidePanel'; target: AnalysisTarget; maxPages?: number }
  | { type: 'getSidePanelTarget' }
  | { type: 'ackSidePanelTarget'; requestId: string }
  | { type: 'sidePanelAnalysisComplete'; target: AnalysisTarget; result: AnalysisJsonResult; tabId?: number }
  | { type: 'sidePanelAnalysisError'; target: AnalysisTarget; error: string; tabId?: number }

export type MessageResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number }

export type MessageToContent =
  | { type: 'fetchZhihuInPage'; url: string; referer?: string }
  | { type: 'sidePanelAnalysisComplete'; target: AnalysisTarget; result: AnalysisJsonResult; tabId?: number }
  | { type: 'sidePanelAnalysisError'; target: AnalysisTarget; error: string; tabId?: number }
