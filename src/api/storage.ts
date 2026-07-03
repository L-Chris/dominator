import type { LLMConfig } from '@/types'

const DEFAULT_CONFIG: LLMConfig = {
  serviceUrl: import.meta.env.VITE_SERVICE_URL || 'http://dominator.home.com',
}

function withDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

export function getDefaultConfig(): LLMConfig {
  return {
    serviceUrl: DEFAULT_CONFIG.serviceUrl,
  }
}

export async function getConfig(): Promise<LLMConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['serviceUrl'], (data: Record<string, string | undefined>) => {
      resolve({
        serviceUrl: withDefault(data.serviceUrl, DEFAULT_CONFIG.serviceUrl),
      })
    })
  })
}

export async function saveConfig(config: LLMConfig): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        serviceUrl: config.serviceUrl.trim(),
      },
      resolve
    )
  })
}
