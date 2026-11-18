import type { SubagentFact } from '../sessionDisplay'
import { t } from '../i18n'
import { IconAgentSpawn } from './icons'

/** 子代理会话的只读横幅,占据输入框的位置。 */
export function ChildSubagentBanner({
  descriptorText,
  subagentModel,
  subagentFacts,
  onBack,
}: {
  descriptorText: string
  subagentModel: string
  subagentFacts: SubagentFact[]
  onBack: () => void
}) {
  return (
    <div className="prompt-panel child-banner" data-testid="child-banner">
      <div className="child-banner-head">
        <span className="child-banner-glyph" aria-hidden="true">
          <IconAgentSpawn size={14} />
        </span>
        <span className="child-banner-tag" title={descriptorText}>
          {t('childSubagentLabel')}
          <span className="child-banner-model">{subagentModel}</span>
        </span>
        <button
          type="button"
          className="child-banner-back"
          onClick={onBack}
        >
          {t('runtimeBackParent')}
        </button>
      </div>
      <div className="child-banner-facts" data-testid="child-snapshot" title={descriptorText}>
        {subagentFacts.map((fact) => (
          <span
            className="child-fact"
            key={fact.key}
            data-fact={fact.key}
            title={fact.hint}
            aria-label={`${fact.label}：${fact.value}`}
          >
            {fact.value}
          </span>
        ))}
      </div>
      <p className="child-banner-note">{t('runtimeChildReadonly')}</p>
    </div>
  )
}
