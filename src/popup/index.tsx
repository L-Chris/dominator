import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { loadFilterSettings, saveFilterSettings } from '@/api/filterSettings'
import { USER_TYPE_OPTIONS } from '@/api/userTypes'

ensurePopupStyle()

function ensurePopupStyle() {
  if (document.getElementById('dominator-popup-style')) return

  const style = document.createElement('style')
  style.id = 'dominator-popup-style'
  style.textContent = `
    * {
      box-sizing: border-box;
    }

    body {
      min-width: 280px;
      margin: 0;
      background: #ffffff;
      color: #24292f;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .popup-shell {
      width: 320px;
      padding: 14px;
    }

    .popup-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid #d8dee4;
    }

    .popup-header h1 {
      margin: 0;
      font-size: 16px;
      line-height: 1.25;
    }

    .popup-header p {
      margin: 3px 0 0;
      color: #57606a;
    }

    .save-status {
      flex: 0 0 auto;
      margin-top: 1px;
      color: #57606a;
      font-size: 12px;
    }

    .option-list {
      display: grid;
      gap: 2px;
      padding-top: 10px;
    }

    .option-row {
      display: flex;
      align-items: center;
      gap: 9px;
      min-height: 34px;
      padding: 6px 4px;
      border-radius: 6px;
      cursor: pointer;
    }

    .option-row:hover {
      background: #f6f8fa;
    }

    .option-row input {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: #0969da;
    }

    .error-text {
      margin-top: 10px;
      padding: 8px 10px;
      border: 1px solid #ffebe9;
      border-radius: 6px;
      background: #fff5f5;
      color: #cf222e;
      word-break: break-word;
    }
  `
  document.head.appendChild(style)
}

function Popup() {
  const [blockedUserTypes, setBlockedUserTypes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const blockedSet = useMemo(() => new Set(blockedUserTypes), [blockedUserTypes])

  useEffect(() => {
    loadFilterSettings()
      .then((settings) => {
        setBlockedUserTypes(settings.blockedUserTypes)
        setError(null)
      })
      .catch((err) => {
        setError(String(err))
      })
      .finally(() => setLoading(false))
  }, [])

  function toggleUserType(userType: string) {
    const next = blockedSet.has(userType)
      ? blockedUserTypes.filter((item) => item !== userType)
      : [...blockedUserTypes, userType]

    setBlockedUserTypes(next)
    setSaving(true)
    saveFilterSettings({ blockedUserTypes: next })
      .then(() => setError(null))
      .catch((err) => {
        setError(String(err))
      })
      .finally(() => setSaving(false))
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div>
          <h1>Dominator</h1>
          <p>折叠指定用户类型的回答</p>
        </div>
        <span className="save-status">{saving ? '保存中' : '已同步'}</span>
      </header>

      {error ? <div className="error-text">{error}</div> : null}

      <section className="option-list" aria-busy={loading}>
        {USER_TYPE_OPTIONS.map((option) => (
          <label className="option-row" key={option.value}>
            <input
              type="checkbox"
              checked={blockedSet.has(option.value)}
              disabled={loading}
              onChange={() => toggleUserType(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </section>
    </main>
  )
}

const rootElement = document.getElementById('root')
if (rootElement) createRoot(rootElement).render(<Popup />)
