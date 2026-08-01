// The full lockup, mark + wordmark on one line. Currently unused: the legal pages were its last
// consumer before their header was reduced to a bare "Back to app" link. Kept as the canonical
// pairing of the two, for whatever page next needs the brand stated in full.
export function FinbroLogo({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center leading-none text-[1.6rem] sm:text-[2rem] md:text-[2.25rem] select-none ${className ?? ""}`}
    >
      {/* Matches the header's profile button exactly (h-8 w-8 md:h-10 md:w-10), so the two round
          objects at either end of the bar read as a pair. That means fixed px rather than the em
          sizing this used before: the mark now tracks the profile button rather than the type, which
          is the point — the balance being matched is across the header, not against the letters. */}
      <FootballMark className="mr-[0.28em] h-8 w-8 shrink-0 md:h-10 md:w-10" />
      <FinbroWordmark />
    </span>
  )
}

// The wordmark on its own, sized by whatever it's dropped into. Currently unused outside FinbroLogo:
// the brand is now stated by the football mark alone in both chrome slots — the desktop nav rail and
// the mobile drawer header. White type with a hard cyan shadow offset down-right.
//
// Two things here are load-bearing, and the treatment falls apart without either:
//   · The shadow is cyan-600, not the brand's #a5f3fc. That light cyan sits at ~91% luminance
//     against white's 100%, so a shadow in it reads as chromatic fringing rather than depth. A
//     shadow has to be darker than the thing casting it. (Matching the Sync League button's cyan
//     was tried and reverted — correcting the tracking was not enough to rescue it.)
//   · Tracking is normal, not tight. The offset is 0.06em; at tracking-tight (-0.025em) the gap
//     between letters is narrower than the offset, so each letter's shadow lands on the next
//     letter's stem and leaves uneven slivers instead of a clean edge.
//
// Offsets are in em so they stay proportional across the two sizes.
export function FinbroWordmark({ className }: { className?: string }) {
  return (
    <span
      className={`font-bold leading-none select-none text-white [text-shadow:0.06em_0.045em_0_#0891b2] ${className ?? ""}`}
    >
      FANTASYNC
    </span>
  )
}

export function FinbroMark({ className }: { className?: string }) {
  return <FootballMark className={`block rounded-full ${className ?? ""}`} />
}

// Stock artwork: a teal field roundel with an orange football on it. Inverted onto the Fantasync
// palette — cyan field, black football:
//
//   field roundel      #3DB39E → #a5f3fc  the wordmark's cyan. As the largest area it also gives
//                                         the mark a hard silhouette against the black header.
//   field marking      #349886 → #7cc4d1  a step down in the same hue, as in the original
//   yard lines         #E4E7E7 → #0D0D0D  had to flip. White on this cyan is a 1.03:1 contrast
//                                         ratio — indistinguishable. Dark lines read at 15:1 and
//                                         keep the "chalk on turf" relationship the original had.
//   football body      #E77944 → #000000  black, per the brief
//   football shading   #C5673A → #2A2A2A  a step up from black, preserving the original's shading
//   laces, tip         unchanged — already near-white, and they sit on the now-black football
//                                         where white is exactly what reads
function FootballMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Fantasync"
      className={className}
    >
      <defs>
        <clipPath id="fantasyncDisc">
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>

      {/* Flat base, not a gradient. The wordmark already runs a white→cyan gradient across "SY"; a
          second one on the disc ran on a different axis and the two competed. */}
      <circle
        cx="50"
        cy="50"
        r="50"
        fill="#a5f3fc"
      />

      {/* Mow stripes — what actually reads as turf rather than a flat cyan disc. Rotated 26.57° to
          run parallel to the yard lines, which in this artwork lie along (2,1). The tonal step is
          deliberately small: mowing shows as a sheen, not a colour change, and too much contrast
          here would compete with the yard lines drawn on top. At a 28-unit pitch each band is
          ~4.5px on screen, so they resolve rather than dissolving into noise. */}
      <g clipPath="url(#fantasyncDisc)" fill="#8fdfec">
        <g transform="rotate(26.57 50 50)">
          <rect x="-50" y="-18" width="200" height="14" />
          <rect x="-50" y="10" width="200" height="14" />
          <rect x="-50" y="38" width="200" height="14" />
          <rect x="-50" y="66" width="200" height="14" />
          <rect x="-50" y="94" width="200" height="14" />
        </g>
      </g>
      <g fill="#0D0D0D">
        <path d="M23.382 32.312l17.872 8.942 7.148-3.577-17.872-8.942zM60.913 31.418l-17.872-8.942-7.149 3.577 17.872 8.941zM28.743 47.513l7.149-3.577-17.872-8.942-7.149 3.577zM48.402 19.793l17.872 8.942 7.149-3.577-17.872-8.941zM55.415 99.703c3.457-.372 6.807-1.101 10.017-2.142l-62.744-31.392c1.116 3.265 2.554 6.378 4.287 9.299l48.44 24.235zM3.723 60.031l7.148-3.576-10.845-5.426c.052 2.555.294 5.062.715 7.511l2.982 1.491zM16.232 53.772l7.149-3.577-17.871-8.941-5.115 2.559c-.079.641-.147 1.286-.202 1.935l16.039 8.024z" />
      </g>
      <path
        fill="#7cc4d1"
        d="M60.383 71.931c5.98-3.358 13.493-1.589 14.434-.005.924 1.557-1.241 8.797-7.222 12.154-5.979 3.357-13.491 1.59-14.433.005-.777-1.312 1.241-8.797 7.221-12.154z"
      />
      <path
        fill="#000000"
        d="M85.699 46.749c4.799-4.771 8.178-10.397 10.444-16.026-5.076-12.137-14.798-21.842-26.945-26.898-5.679 2.262-11.357 5.638-16.177 10.43-15.693 15.605-15.601 40.997-12.076 44.503 4.264 4.239 29.061 3.596 44.754-12.009z"
      />
      <path
        fill="#CDCFCF"
        d="M58.588 38.535l18.981-18.955c.788-.787 2.065-.787 2.854 0 .788.787.788 2.062 0 2.85l-18.981 18.955c-.788.787-2.066.787-2.854 0s-.788-2.063 0-2.85z"
      />
      <path
        fill="#EFF1F1"
        d="M60.315 34.287c-.373-.373-.978-.373-1.351 0l-.676.676c-.373.373-.373.977 0 1.351l5.403 5.402c.373.373.978.373 1.351 0l.675-.675c.373-.373.373-.979 0-1.352l-5.402-5.402zm4.99-5.013c-.374-.373-.981-.373-1.355 0l-.679.675c-.374.373-.374.979 0 1.352l5.424 5.403c.375.373.981.373 1.356 0l.678-.675c.375-.374.375-.979 0-1.352l-5.424-5.403zm5.003-4.981c-.373-.373-.978-.373-1.351 0l-.676.676c-.373.373-.373.979 0 1.352l5.404 5.402c.373.373.978.373 1.351 0l.676-.676c.373-.373.373-.978 0-1.351l-5.404-5.403zm10.416.391l-5.403-5.402c-.373-.374-.978-.374-1.351 0l-.675.675c-.373.373-.373.978 0 1.351l5.402 5.404c.373.373.978.373 1.351 0l.676-.676c.373-.374.373-.978 0-1.352z"
      />
      <path
        fill="#2A2A2A"
        d="M60.378 17.255c4.599-4.573 9.981-7.844 15.398-10.1-2.098-1.264-4.295-2.379-6.578-3.33-5.679 2.262-11.357 5.638-16.177 10.43-15.693 15.605-15.601 40.997-12.076 44.503 1.084 1.078 3.5 1.838 6.753 2.118-2.874-5.688-2.055-28.968 12.68-43.621z"
      />
      <path
        fill="#EFF1F1"
        d="M39.145 46.268c2.529 1.873 5.623 4.355 8.421 7.15 2.445 2.443 4.652 5.112 6.426 7.437 2.72-.216 5.689-.693 8.769-1.479-1.776-2.617-5.288-7.481-9.479-11.667-4.893-4.889-10.707-8.843-12.779-10.195-.736 3.087-1.167 6.053-1.358 8.754z"
      />
      <path
        fill="#CCCDCD"
        d="M46.381 52.271c.017-2.882.329-6.213 1.036-9.75-2.991-2.384-5.651-4.181-6.915-5.006-.18.751-.339 1.495-.482 2.23l-.035.19c-.129.666-.242 1.324-.343 1.973l-.034.22c-.216 1.43-.369 2.814-.463 4.135v.006c2.177 1.611 4.771 3.676 7.236 6.002z"
      />
    </svg>
  )
}
