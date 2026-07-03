import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { resultToMarkdown } from '@/components/AnalysisModal'
import { useAnalysis } from '@/hooks/useAnalysis'
import type { SidePanelAnalysisRequest } from '@/types'

marked.setOptions({
  breaks: true,
  gfm: true,
})

function getSidePanelTarget(): Promise<SidePanelAnalysisRequest | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getSidePanelTarget' }, (res) => {
      resolve(res?.ok ? (res.data as SidePanelAnalysisRequest | null) : null)
    })
  })
}

const SidePanel = () => {
  const { loading, step, error, result, articleCount, answerCount, target, analyze } = useAnalysis()
  const [empty, setEmpty] = useState(true)
  const activeKeyRef = useRef('')
  const lastRequestIdRef = useRef('')

  const startAnalysis = useCallback(async () => {
    const request = await getSidePanelTarget()
    if (!request?.target?.userId) {
      return
    }
    if (request.requestId === lastRequestIdRef.current) return

    lastRequestIdRef.current = request.requestId
    const key = request.requestId
    activeKeyRef.current = key
    setEmpty(false)

    analyze(request.target, {
      maxPages: request.maxPages,
      tabId: request.tabId,
      onComplete: (analysisResult) => {
        if (activeKeyRef.current !== key) return
        chrome.runtime.sendMessage({
          type: 'sidePanelAnalysisComplete',
          target: request.target,
          result: analysisResult,
          tabId: request.tabId,
        })
      },
      onError: (message) => {
        if (activeKeyRef.current !== key) return
        chrome.runtime.sendMessage({
          type: 'sidePanelAnalysisError',
          target: request.target,
          error: message,
          tabId: request.tabId,
        })
      },
    })
  }, [analyze])

  useEffect(() => {
    startAnalysis()
    const listener = (msg: { type?: string }) => {
      if (msg.type === 'sidePanelTargetUpdated') startAnalysis()
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [startAnalysis])

  const bodyHtml = useMemo(() => {
    if (error) {
      return DOMPurify.sanitize(marked.parse(`**分析失败:**\n\n${error}`) as string)
    }
    if (result) {
      return DOMPurify.sanitize(marked.parse(resultToMarkdown(result)) as string)
    }
    return null
  }, [error, result])

  const title = target ? (loading ? `分析中: ${target.userName}` : `分析报告: ${target.userName}`) : 'Dominator'

  return (
    <div className="panel">
      <header className="header">
        <div className="icon">分</div>
        <div className="titleWrap">
          <h1>{title}</h1>
          <p>浏览器侧边栏分析</p>
        </div>
      </header>

      <main className="body">
        {empty && (
          <div className="empty">
            <strong>等待分析目标</strong>
            <span>在知乎页面点击“分析”开始。</span>
          </div>
        )}

        {loading && !bodyHtml && (
          <div className="loading">
            <div className="spinner" />
            <div>
              已获取 {articleCount} 篇文章，{answerCount} 条回答
              <br />
              <span>{step}</span>
            </div>
          </div>
        )}

        {bodyHtml && <div className="markdown" dangerouslySetInnerHTML={{ __html: bodyHtml }} />}
      </main>

      <style>{`
        * {
          box-sizing: border-box;
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          color: #24292f;
          background: #ffffff;
        }

        .panel {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }

        .header {
          position: sticky;
          top: 0;
          z-index: 2;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 16px;
          color: #ffffff;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08);
        }

        .icon {
          width: 34px;
          height: 34px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.2);
          font-weight: 800;
          flex: 0 0 auto;
        }

        .titleWrap {
          min-width: 0;
        }

        h1 {
          margin: 0;
          font-size: 16px;
          line-height: 1.3;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          letter-spacing: 0;
        }

        p {
          margin: 2px 0 0;
          font-size: 12px;
          opacity: 0.82;
        }

        .body {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
        }

        .empty,
        .loading {
          min-height: 180px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          color: #57606a;
          text-align: center;
          font-size: 14px;
        }

        .empty strong {
          color: #24292f;
          font-size: 15px;
        }

        .spinner {
          width: 34px;
          height: 34px;
          border: 3px solid #eaeef2;
          border-top-color: #667eea;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        .loading span {
          color: #667eea;
          font-weight: 600;
        }

        .cursor {
          display: inline-block;
          width: 3px;
          height: 18px;
          background: #667eea;
          margin-left: 2px;
          animation: blink 1s step-end infinite;
          vertical-align: text-bottom;
        }

        .markdown {
          font-size: 14px;
          line-height: 1.7;
        }

        .markdown h1,
        .markdown h2,
        .markdown h3 {
          margin: 1.2em 0 0.5em;
          line-height: 1.35;
          color: #24292f;
          letter-spacing: 0;
        }

        .markdown h3 {
          font-size: 17px;
        }

        .markdown p {
          margin: 0.8em 0;
          color: #24292f;
          opacity: 1;
          font-size: 14px;
        }

        .markdown table {
          width: 100%;
          border-collapse: collapse;
          margin: 12px 0;
          font-size: 12px;
        }

        .markdown th,
        .markdown td {
          border: 1px solid #d0d7de;
          padding: 8px;
          vertical-align: top;
        }

        .markdown th {
          background: #f6f8fa;
          font-weight: 700;
        }

        .markdown code {
          background: #f6f8fa;
          border: 1px solid #d0d7de;
          border-radius: 4px;
          padding: 1px 5px;
          font-size: 12px;
        }

        .markdown ul {
          padding-left: 20px;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<SidePanel />)
