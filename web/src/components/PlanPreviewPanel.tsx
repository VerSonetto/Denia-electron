import { useMemo } from 'react'
import { localeRevision, t } from '../i18n'
import { useContainedWheel } from '../hooks/useContainedWheel'
import { MarkdownText } from '../markdown/MarkdownText'
import type { MarkdownLabels } from '../markdown/MarkdownText'
import { IconPlan } from './icons'
import { PanelHead } from './PanelChrome'

/** 待审批计划的只读预览；审批控件留在对话输入区。 */
export function PlanPreviewPanel({ title, planText }: { title?: string; planText: string }) {
  const rootRef = useContainedWheel<HTMLDivElement>()
  const labels = useMemo<MarkdownLabels>(
    () => ({
      code: { copyLabel: t('copy'), copiedLabel: t('copied') },
      footnotes: t('footnotes'),
    }),
    [localeRevision()],
  )

  return (
    <section ref={rootRef} className="plan-preview-panel" aria-label={t('planReviewTitle')} data-testid="plan-preview-panel">
      <PanelHead
        icon={<IconPlan size={14} />}
        title={title?.trim() || t('planReviewTitle')}
        subtitle={t('planReviewWaiting')}
      />
      <div className="plan-review-body plan-preview-body">
        {planText.trim() ? (
          <MarkdownText text={planText} streaming={false} labels={labels} />
        ) : (
          <div className="plan-review-parse-failed">{t('planReviewParseFailed')}</div>
        )}
      </div>
    </section>
  )
}
