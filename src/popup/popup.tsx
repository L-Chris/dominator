import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { getConfig, getDefaultConfig, saveConfig } from '@/api/storage'
import type { LLMConfig } from '@/types'

const styles = {
  container: {
    padding: '20px',
    background: 'white',
    width: '380px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '20px',
  },
  logo: {
    width: '36px',
    height: '36px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '18px',
    color: 'white',
    fontWeight: 'bold',
  },
  title: {
    fontSize: '16px',
    fontWeight: '700',
    color: '#1a202c',
  },
  subtitle: {
    fontSize: '11px',
    color: '#718096',
    marginTop: '2px',
  },
  field: {
    marginBottom: '14px',
  },
  label: {
    display: 'block',
    fontSize: '13px',
    fontWeight: '600',
    color: '#4a5568',
    marginBottom: '4px',
  },
  help: {
    fontSize: '11px',
    color: '#a0aec0',
    marginBottom: '5px',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    fontSize: '13px',
    color: '#2d3748',
    background: '#f7fafc',
    outline: 'none',
  },
  saveBtn: {
    width: '100%',
    padding: '9px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'opacity 0.2s',
    marginTop: '4px',
  },
  resetBtn: {
    width: '100%',
    padding: '7px',
    background: '#f7fafc',
    color: '#718096',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    fontSize: '12px',
    cursor: 'pointer',
    marginTop: '8px',
  },
  status: {
    marginTop: '10px',
    padding: '7px',
    background: '#c6f6d5',
    color: '#22543d',
    borderRadius: '6px',
    fontSize: '12px',
    textAlign: 'center' as const,
  },
}

const Popup = () => {
  const [config, setConfig] = useState<LLMConfig>({ serviceUrl: '' })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getConfig().then(setConfig)
  }, [])

  const handleSave = async () => {
    await saveConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleReset = () => {
    setConfig(getDefaultConfig())
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.logo}>D</div>
        <div>
          <div style={styles.title}>Dominator</div>
          <div style={styles.subtitle}>配置后端服务地址</div>
        </div>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>后端服务地址</label>
        <div style={styles.help}>浏览器扩展将数据发送到此地址进行分析和存储</div>
        <input
          style={styles.input}
          type="text"
          value={config.serviceUrl}
          onChange={(e) => setConfig({ serviceUrl: e.target.value })}
          placeholder="http://localhost:4178"
        />
      </div>

      <button
        style={styles.saveBtn}
        onClick={handleSave}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9' }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
      >
        保存设置
      </button>
      <button
        style={styles.resetBtn}
        onClick={handleReset}
      >
        恢复默认
      </button>
      {saved && <div style={styles.status}>✓ 保存成功！</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Popup />)
