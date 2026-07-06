export const USER_TYPE_OPTIONS = [
  { value: 'normal_user', label: '普通用户' },
  { value: 'vertical_enthusiast', label: '垂类爱好者' },
  { value: 'brand_fan', label: '品牌粉' },
  { value: 'soft_marketing_account', label: '软广号' },
  { value: 'hard_promotion_account', label: '硬广导流号' },
  { value: 'template_spam_account', label: '模板搬运号' },
  { value: 'opinion_manipulation_account', label: '舆论带节奏号' },
  { value: 'coordinated_account', label: '协同水军号' },
  { value: 'bot_like_account', label: '机器人式账号' },
] as const

const USER_TYPE_LABELS = Object.fromEntries(
  USER_TYPE_OPTIONS.map((option) => [option.value, option.label])
) as Record<string, string>

export function getUserTypeLabel(userType?: string): string | null {
  return userType && userType !== 'uncertain' ? USER_TYPE_LABELS[userType] || null : null
}
