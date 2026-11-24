/** 设置页的分类与 URL 路由。分类顺序同时决定左侧导航的顺序。 */
export const SETTINGS_TABS = [
  'general',
  'subagents',
  'presets',
  'prompts',
  'models',
  'usage',
  'memory',
  'channels',
  'remote',
  'runtime',
  'appearance',
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

export function settingsTabFromHash(hash: string): SettingsTab | null {
  // `#usage` 是迁移前的独立用量页地址,保留直达能力:老书签与外部链接
  // 落到设置里的用量分类,而不是空白页。
  if (hash === '#usage') return 'usage'
  if (hash === '#settings' || hash === '#settings/') return 'general'
  const match = /^#settings\/([a-z-]+)$/.exec(hash)
  if (!match) return null
  return (SETTINGS_TABS as readonly string[]).includes(match[1])
    ? (match[1] as SettingsTab)
    : null
}

export function settingsHash(tab: SettingsTab): string {
  return `#settings/${tab}`
}
