import type { TrajectoryQuote } from '../trajectory'
import type { PastedImage, PendingAttachment } from '../types'
import { t } from '../i18n'
import { isGenericImageName } from '../userImages'
import { IconBranch, IconClose, IconFile } from './icons'

/** 输入框上方的附件区:轨迹引用、粘贴图片与路径附件。 */
export function ComposerAttachments({
  quotes,
  images,
  attachments,
  onRemoveQuote,
  onRemoveImage,
  onRemoveAttachment,
}: {
  quotes: TrajectoryQuote[]
  images: PastedImage[]
  attachments: PendingAttachment[]
  onRemoveQuote: (id: string) => void
  onRemoveImage: (index: number) => void
  onRemoveAttachment: (index: number) => void
}) {
  if (quotes.length === 0 && images.length === 0 && attachments.length === 0) return null
  return (
    <div className="composer-attachments">
      {quotes.map((quote) => (
        <span className="att-chip traj-quote-chip" key={quote.id}>
          <IconBranch size={12} />
          <span className="att-name" title={quote.title}>
            {quote.title}
          </span>
          <button
            type="button"
            className="att-remove"
            title={t('removeAttachment')}
            onClick={(event) => {
              event.stopPropagation()
              onRemoveQuote(quote.id)
            }}
          >
            <IconClose size={10} />
          </button>
        </span>
      ))}
      {images.map((image, index) => (
        <div className="composer-image-thumb" key={`img-${index}`}>
          <img src={image.preview} alt="" />
          {!isGenericImageName(image.name) && (
            <span className="composer-image-label" title={image.name}>
              {image.name}
            </span>
          )}
          <button
            type="button"
            className="composer-image-remove"
            title={t('removeAttachment')}
            onClick={(event) => {
              event.stopPropagation()
              onRemoveImage(index)
            }}
          >
            <IconClose size={10} />
          </button>
        </div>
      ))}
      {attachments.map((attachment, index) => (
        <span className="att-chip" key={`att-${index}`}>
          <IconFile size={12} />
          <span className="att-name" title={attachment.path}>{attachment.name}</span>
          <button
            type="button"
            className="att-remove"
            title={t('removeAttachment')}
            onClick={(event) => {
              event.stopPropagation()
              onRemoveAttachment(index)
            }}
          >
            <IconClose size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}
