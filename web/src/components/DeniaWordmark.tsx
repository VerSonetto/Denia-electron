import { useId } from 'react'
import { DENIA_GLYPH_PATHS } from './deniaGlyph'

export function DeniaWordmark() {
  const cuts = useId()
  return (
    <svg className="denia-wordmark" viewBox="0 0 1100 280" role="img" aria-label="Denia" focusable="false" fill="currentColor">
      <defs>
        <mask id={cuts} maskUnits="userSpaceOnUse" x="-4" y="-4" width="808" height="288" style={{ maskType: 'luminance' }}>
          <rect x="-4" y="-4" width="808" height="288" fill="white" />
          <path d="M-8 211L64 181V205L-8 235Z M223 203L290 175V201L223 229Z M443 203L511 175V201L443 229Z M679 203L751 173V199L679 229Z" fill="black" />
        </mask>
      </defs>
      <g transform="translate(-112 -118)">
        {DENIA_GLYPH_PATHS.map((d) => <path key={d} d={d} />)}
      </g>
      <g transform="translate(312)" >
        <g mask={`url(#${cuts})`}>
          <path d="M194 174H52C58 211 84 229 118 229C143 229 163 222 181 209L201 246C178 265 150 274 115 274C44 274 0 230 0 160C0 94 42 49 104 49C168 49 199 94 199 151ZM52 133H147C144 107 129 93 103 93C78 93 60 107 52 133Z" fillRule="evenodd" />
          <path d="M232 57H278V79C294 59 314 49 341 49C391 49 417 80 417 137V270H367V145C367 112 353 96 330 96C301 96 282 118 282 150V249L232 270Z" />
          <path d="M452 12H502V48H452ZM452 82L502 61V270H452Z" />
          <path d="M638 49C703 49 742 94 742 160V270H694V246C678 265 657 274 630 274C573 274 536 230 536 162C536 94 575 49 638 49ZM639 96C607 96 586 120 586 161C586 202 607 226 639 226C672 226 692 202 692 161C692 120 672 96 639 96Z" fillRule="evenodd" />
        </g>
      </g>
    </svg>
  )
}
