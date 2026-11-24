// Prompt-cache identity normalization.
//
// OpenAI accepts at most 64 characters for `prompt_cache_key`. Session ids fit
// verbatim; longer identities get a stable FNV-1a digest so a restart does not
// remint the key and drop the provider's cache.

export function normalizePromptCacheKey(value: string): string | undefined {
  const key = value.trim()
  if (key === '') return undefined
  if ([...key].length <= 64) return key
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = (1n << 64n) - 1n
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & mask
  }
  return `pc_${hash.toString(16).padStart(16, '0')}`
}