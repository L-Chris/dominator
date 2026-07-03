import { useEffect, useMemo } from 'react'
import type { FC } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

interface AnalysisModalProps {
  visible: boolean
  title: string
  loading: boolean
  step: string
  error: string | null
  result: string | null
  articleCount: number
  answerCount: number
  onClose: () => void
}

marked.setOptions({
  breaks: true,
  gfm: true,
})

export function resultToMarkdown(text: string): string {
  return text
}

const AnalysisModal: FC<AnalysisModalProps> = ({
  visible, title, loading, step, error, result,
  articleCount, answerCount, onClose,
}) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (visible) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [visible, onClose])

  const bodyHtml = useMemo(() => {
    if (error) {
      const md = `**分析失败:**\n\n${error}`
      return DOMPurify.sanitize(marked.parse(md) as string)
    }
    if (result) {
      return DOMPurify.sanitize(marked.parse(resultToMarkdown(result)) as string)
    }
    return null
  }, [error, result])

  const showLoadingHint = loading && !bodyHtml

  if (!visible) return null

  return (
    <>
      <div className="za-modal-panel">
        <div className="za-modal-header">
          <div className="za-modal-header-left">
            <div className="za-modal-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="za-modal-title">{title}</h3>
          </div>
          <button className="za-modal-close" onClick={onClose} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="za-modal-body za-body">
          {showLoadingHint && (
            <div className="za-loading-state">
              <div className="za-loading-spinner" />
              <div className="za-loading-text">
                已获取 {articleCount} 篇文章, {answerCount} 条回答
                <br />
                <span className="za-loading-step">{step}</span>
              </div>
            </div>
          )}
          {bodyHtml && (
            <div className="za-markdown" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          )}
          {!loading && !bodyHtml && !error && (
            <div className="za-empty-state">点击分析按钮开始</div>
          )}
        </div>
      </div>
      <style>{`
        .za-modal-panel {
          position: fixed;
          top: 0;
          right: 0;
          background: white;
          border-left: 1px solid #e2e8f0;
          width: min(460px, 92vw);
          height: 100vh;
          display: flex;
          flex-direction: column;
          box-shadow: -12px 0 32px rgba(15, 23, 42, 0.22);
          z-index: 100000;
          animation: za-slideIn 0.22s ease-out;
          overflow: hidden;
        }

        .za-modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px 24px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }

        .za-modal-header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .za-modal-icon {
          width: 40px;
          height: 40px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .za-modal-title {
          margin: 0;
          font-size: 17px;
          font-weight: 700;
          letter-spacing: 0;
          max-width: 340px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .za-modal-close {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          width: 32px;
          height: 32px;
          border-radius: 8px;
          cursor: pointer;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }

        .za-modal-close:hover {
          background: rgba(255, 255, 255, 0.3);
        }

        .za-modal-body {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          min-height: 0;
        }

        .za-loading-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 200px;
          gap: 16px;
        }

        .za-loading-spinner {
          width: 40px;
          height: 40px;
          border: 3px solid #e2e8f0;
          border-top-color: #667eea;
          border-radius: 50%;
          animation: za-spin 0.8s linear infinite;
        }

        .za-loading-text {
          text-align: center;
          color: #4a5568;
          font-size: 14px;
          line-height: 1.6;
        }

        .za-loading-step {
          color: #667eea;
          font-weight: 500;
        }

        .za-empty-state {
          text-align: center;
          padding: 60px 20px;
          color: #a0aec0;
          font-size: 15px;
        }

        .za-cursor {
          display: inline-block;
          width: 3px;
          height: 18px;
          background: #667eea;
          margin-left: 2px;
          animation: za-blink 1s step-end infinite;
          vertical-align: text-bottom;
        }

        @keyframes za-slideIn {
          from {
            opacity: 0;
            transform: translateX(24px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        @keyframes za-spin {
          to { transform: rotate(360deg); }
        }

        @keyframes za-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }

        .za-body {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: 14px;
          line-height: 1.7;
          color: #2d3748;
          padding: 24px;
          background: white;
          display: block;
        }

        @media (max-width: 560px) {
          .za-modal-panel {
            width: 100vw;
          }

          .za-modal-title {
            max-width: calc(100vw - 128px);
          }
        }

        .za-markdown {
          display: block;
        }

        .za-markdown h1,
        .za-markdown h2,
        .za-markdown h3,
        .za-markdown h4,
        .za-markdown h5,
        .za-markdown h6 {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-weight: 700;
          line-height: 1.3;
          margin: 1.5em 0 0.5em;
          color: #1a202c;
          display: block;
          letter-spacing: -0.01em;
        }

        .za-markdown h1 {
          font-size: 28px;
          border-bottom: 2px solid #e2e8f0;
          padding-bottom: 8px;
        }

        .za-markdown h2 {
          font-size: 22px;
          border-bottom: 1px solid #e2e8f0;
          padding-bottom: 6px;
          color: #2d3748;
        }

        .za-markdown h3 {
          font-size: 18px;
          color: #4a5568;
        }

        .za-markdown p {
          margin: 0.8em 0;
          display: block;
          font-family: inherit;
          font-size: 14px;
          line-height: 1.7;
          color: #2d3748;
        }

        .za-markdown strong {
          font-weight: 700;
          color: #1a202c;
        }

        .za-markdown em {
          font-style: italic;
          color: #4a5568;
        }

        .za-markdown ul,
        .za-markdown ol {
          padding-left: 24px;
          margin: 0.8em 0;
          display: block;
        }

        .za-markdown li {
          display: list-item;
          margin: 0.4em 0;
          font-size: 14px;
          line-height: 1.7;
          color: #2d3748;
        }

        .za-markdown code {
          background: #f7fafc;
          border: 1px solid #e2e8f0;
          border-radius: 4px;
          padding: 2px 6px;
          font-family: "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: 13px;
          color: #d53f8c;
        }

        .za-markdown pre {
          background: #1a202c;
          border-radius: 8px;
          padding: 16px;
          overflow-x: auto;
          margin: 1em 0;
          display: block;
          font-size: 13px;
          line-height: 1.6;
        }

        .za-markdown pre code {
          background: none;
          border: none;
          padding: 0;
          color: #e2e8f0;
        }

        .za-markdown blockquote {
          border-left: 4px solid #667eea;
          margin: 1em 0;
          padding: 12px 16px;
          background: linear-gradient(to right, #f7fafc 0%, transparent 100%);
          color: #4a5568;
          display: block;
          border-radius: 0 8px 8px 0;
        }

        .za-markdown table {
          border-collapse: collapse;
          width: 100%;
          margin: 1em 0;
          display: table;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }

        .za-markdown th,
        .za-markdown td {
          border: 1px solid #e2e8f0;
          padding: 10px 14px;
          text-align: left;
          font-size: 14px;
        }

        .za-markdown th {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          font-weight: 600;
        }

        .za-markdown tr:nth-child(even) {
          background: #f7fafc;
        }

        .za-markdown a {
          color: #667eea;
          text-decoration: none;
          border-bottom: 1px solid transparent;
          transition: border-color 0.2s;
        }

        .za-markdown a:hover {
          border-bottom-color: #667eea;
        }

        .za-markdown hr {
          border: none;
          border-top: 2px solid #e2e8f0;
          margin: 1.5em 0;
          display: block;
          height: 2px;
        }
      `}</style>
    </>
  )
}

export default AnalysisModal
