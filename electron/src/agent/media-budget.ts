// Per-request media budget.
//
// Images are the only content whose size can jump by hundreds of thousands of
// tokens in a single step (a full-page screenshot), and once in history they are
// re-sent on every later request. The aggregate payload of one request is capped;
// over budget, the oldest images are replaced by a one-line note. The newest
// message that carries images is always kept, so a fresh screenshot is never the
// one dropped.

import type { ChatMessage, ImageData } from '../core/wire.ts'

/** Aggregate base64 payload allowed in one request (mirrors ZCode's 40 MiB). */
export const DEFAULT_REQUEST_MEDIA_BUDGET_BYTES = 40 * 1024 * 1024

export const OMITTED_MEDIA_NOTE =
  '\n[图片已省略:单次请求的图片总量超出预算。需要重看时请重新截图或重新读取该文件]'

/** Base64 payload size of one image (the string length is the encoded size). */
function imageBytes(image: ImageData): number {
  return image.data.length
}

export interface MediaBudgetResult {
  messages: ChatMessage[]
  omittedImages: number
  keptBytes: number
}

/**
 * Drop the oldest images until the request fits the budget.
 *
 * `messages` is left untouched; a changed message is a shallow copy with its
 * images removed and the note appended.
 */
export function applyMediaBudget(
  messages: readonly ChatMessage[],
  maxBytes: number = DEFAULT_REQUEST_MEDIA_BUDGET_BYTES,
): MediaBudgetResult {
  const withImages = messages.filter(
    (message) => message.images !== undefined && message.images.length > 0,
  )
  if (withImages.length === 0) return { messages: [...messages], omittedImages: 0, keptBytes: 0 }

  const total = withImages.reduce(
    (sum, message) => sum + (message.images ?? []).reduce((bytes, image) => bytes + imageBytes(image), 0),
    0,
  )
  if (total <= maxBytes) return { messages: [...messages], omittedImages: 0, keptBytes: total }

  const out = [...messages]
  let kept = 0
  let omitted = 0
  // Newest first: the freshest images win the remaining budget.
  for (let index = withImages.length - 1; index >= 0; index -= 1) {
    const message = withImages[index]!
    const images = message.images ?? []
    const bytes = images.reduce((sum, image) => sum + imageBytes(image), 0)
    // The freshest images are what the model is acting on: keep them even when
    // they alone exceed the budget, and let the older ones make room.
    if (index === withImages.length - 1 || kept + bytes <= maxBytes) {
      kept += bytes
      continue
    }
    const at = out.indexOf(message)
    if (at < 0) continue
    omitted += images.length
    out[at] = {
      ...message,
      content: `${message.content}${OMITTED_MEDIA_NOTE}`,
      images: [],
    }
  }
  return { messages: out, omittedImages: omitted, keptBytes: kept }
}