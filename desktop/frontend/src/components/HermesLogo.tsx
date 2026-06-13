interface Props {
  size?: number
  className?: string
}

export function HermesLogo({ size = 36, className = '' }: Props) {
  const h = Math.round(size * 0.67)
  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 60 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Left wing — 3 feather arcs fanning outward */}
      <path d="M16,13 C11,8 4,9 2,15"   stroke="#f59e0b" strokeWidth="2.6" strokeLinecap="round"/>
      <path d="M16,19 C11,14 4,15 2,20"  stroke="#f59e0b" strokeWidth="2.0" strokeLinecap="round"/>
      <path d="M16,25 C11,20 4,21 2,26"  stroke="#f59e0b" strokeWidth="1.4" strokeLinecap="round" strokeOpacity="0.7"/>

      {/* Right wing — mirror */}
      <path d="M44,13 C49,8 56,9 58,15"  stroke="#f59e0b" strokeWidth="2.6" strokeLinecap="round"/>
      <path d="M44,19 C49,14 56,15 58,20" stroke="#f59e0b" strokeWidth="2.0" strokeLinecap="round"/>
      <path d="M44,25 C49,20 56,21 58,26" stroke="#f59e0b" strokeWidth="1.4" strokeLinecap="round" strokeOpacity="0.7"/>

      {/* Envelope body */}
      <rect x="15" y="8" width="30" height="24" rx="3" fill="url(#hermesGold)"/>

      {/* Envelope flap V */}
      <path d="M15,8 L30,22 L45,8" fill="none" stroke="#92400e" strokeWidth="1.4" strokeLinejoin="round"/>

      <defs>
        <linearGradient id="hermesGold" x1="15" y1="8" x2="45" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#fbbf24"/>
          <stop offset="100%" stopColor="#d97706"/>
        </linearGradient>
      </defs>
    </svg>
  )
}
