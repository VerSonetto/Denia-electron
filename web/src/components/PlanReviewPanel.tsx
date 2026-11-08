import { useMemo, useState } from 'react'
import { t } from '../i18n'
import type { ApprovalDecisionPayload } from '../api'
import type { ModelCatalog, ModelSelection } from '../types'
import { ComposerModelMenu } from './ComposerModelMenu'
import { ComposerEffortControl } from './ComposerEffortControl'
import { resolveSessionReasoningEffort } from '../modelCatalog'
import { IconCheck, IconClose, IconPlan } from './icons'

/**
 * 计划审批操作卡:正文在右侧「计划」标签预览，这里只保留审批决策。
 * 模型与思考强度浮层必须能越出卡片，不能用 overflow 裁切。
 */
export function PlanReviewPanel({
  title,
  planText,
  catalog,
  selection,
  onDecision,
  onExit,
}: {
  title?: string
  /** 仅用于确认审批载荷中有计划；正文由右侧预览面板渲染。 */
  planText: string
  catalog: ModelCatalog | null
  selection: ModelSelection | null
  onDecision: (payload: ApprovalDecisionPayload) => Promise<void>
  onExit: () => void
}) {
  const [choice, setChoice] = useState<'approve' | 'reject'>('approve')
  const [executeMode, setExecuteMode] = useState<'auto-edit' | 'full'>('auto-edit')
  const [model, setModel] = useState<ModelSelection | null>(selection)
  const [modelPicked, setModelPicked] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const trimmedFeedback = feedback.trim()
  const canSubmit = planText.trim().length > 0 && !submitting
  const planEfforts = useMemo(() => {
    if (!catalog || !model) return []
    const group = catalog.groups.find((entry) => entry.id === model.provider)
    return group?.models.find((entry) => entry.id === model.model)?.reasoning?.efforts ?? []
  }, [catalog, model])
  const planEffort = model
    ? resolveSessionReasoningEffort(planEfforts, model.reasoningEffort)
    : undefined

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    const payload: ApprovalDecisionPayload =
      choice === 'approve'
        ? {
            decision: 'allow-once',
            executeMode,
            selection: modelPicked && model ? model : undefined,
            feedback: trimmedFeedback || undefined,
          }
        : { decision: 'reject', feedback: trimmedFeedback || undefined }
    try {
      await onDecision(payload)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="plan-review-panel" data-testid="plan-review-actions">
      <div className="plan-review-head">
        <span className="plan-review-head-icon"><IconPlan size={14} /></span>
        <span className="plan-review-title">{title?.trim() || t('planReviewTitle')}</span>
        <span className="plan-review-waiting">{t('planReviewWaiting')}</span>
      </div>
      <div className="plan-review-actions">
        <div className="plan-review-choice" role="radiogroup" aria-label={t('planReviewTitle')}>
          <button type="button" role="radio" aria-checked={choice === 'approve'}
            className={`plan-review-choice-btn${choice === 'approve' ? ' active' : ''}`}
            onClick={() => setChoice('approve')}>
            <IconCheck size={13} />{t('planReviewApprove')}
          </button>
          <button type="button" role="radio" aria-checked={choice === 'reject'}
            className={`plan-review-choice-btn${choice === 'reject' ? ' active' : ''}`}
            onClick={() => setChoice('reject')}>
            <IconClose size={13} />{t('planReviewReject')}
          </button>
        </div>
        {choice === 'approve' && (
          <div className="plan-review-exec">
            <div className="plan-review-modes" role="radiogroup" aria-label={t('planReviewApprove')}>
              <button type="button" role="radio" aria-checked={executeMode === 'auto-edit'}
                className={`plan-review-mode-btn${executeMode === 'auto-edit' ? ' active' : ''}`}
                onClick={() => setExecuteMode('auto-edit')}>{t('planReviewEditMode')}</button>
              <button type="button" role="radio" aria-checked={executeMode === 'full'}
                className={`plan-review-mode-btn${executeMode === 'full' ? ' active' : ''}`}
                onClick={() => setExecuteMode('full')}>{t('planReviewFullMode')}</button>
            </div>
            {model && catalog && catalog.groups.length > 0 && (
              <div className="plan-review-model">
                <span className="plan-review-model-label">{t('planReviewModelLabel')}</span>
                <ComposerModelMenu catalog={catalog} selection={model} disabled={submitting}
                  onChange={(next) => { setModel(next); setModelPicked(true) }} />
                {planEffort && (
                  <ComposerEffortControl
                    key={`${model.provider}:${model.model}`}
                    efforts={planEfforts}
                    value={planEffort}
                    disabled={submitting}
                    onChange={(effort) => {
                      setModel((prev) => (prev ? { ...prev, reasoningEffort: effort } : prev))
                      setModelPicked(true)
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}
        <div className="plan-review-feedback">
          <textarea className="plan-review-feedback-input" value={feedback}
            placeholder={t('planReviewFeedbackPlaceholder')}
            onChange={(event) => setFeedback(event.target.value)} rows={2} />
          <div className="plan-review-hint">{t('planReviewRewriteHint')}</div>
        </div>
        <div className="plan-review-buttons">
          <button type="button" className="plan-review-exit" onClick={onExit} disabled={submitting}>
            {t('planReviewExit')}
          </button>
          <button type="button" className="plan-review-submit" onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? t('planReviewSubmitting') : t('planReviewSubmit')}
          </button>
        </div>
      </div>
    </div>
  )
}
