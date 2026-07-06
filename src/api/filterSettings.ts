export interface FilterSettings {
  blockedUserTypes: string[]
}

export const DEFAULT_FILTER_SETTINGS: FilterSettings = {
  blockedUserTypes: [],
}

const FILTER_SETTINGS_KEY = 'dominatorFilterSettings'

export async function loadFilterSettings(): Promise<FilterSettings> {
  const stored = await chrome.storage.sync.get(FILTER_SETTINGS_KEY)
  return normalizeFilterSettings(stored[FILTER_SETTINGS_KEY])
}

export async function saveFilterSettings(settings: FilterSettings): Promise<void> {
  await chrome.storage.sync.set({
    [FILTER_SETTINGS_KEY]: normalizeFilterSettings(settings),
  })
}

export function parseFilterSettingsChange(changes: Record<string, chrome.storage.StorageChange>): FilterSettings | null {
  const change = changes[FILTER_SETTINGS_KEY]
  return change ? normalizeFilterSettings(change.newValue) : null
}

function normalizeFilterSettings(value: unknown): FilterSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_FILTER_SETTINGS

  const raw = value as Partial<FilterSettings>
  const blockedUserTypes = Array.isArray(raw.blockedUserTypes)
    ? Array.from(new Set(raw.blockedUserTypes.map(String).filter(Boolean)))
    : DEFAULT_FILTER_SETTINGS.blockedUserTypes

  return { blockedUserTypes }
}
