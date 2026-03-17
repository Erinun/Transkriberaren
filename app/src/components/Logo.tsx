interface Props {
  size?: number;
  className?: string;
}

export default function Logo({ size = 48, className = "" }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="logo-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      {/* Document body */}
      <rect x="10" y="4" width="22" height="30" rx="3" fill="url(#logo-grad)" opacity="0.9" />
      {/* Folded corner */}
      <path d="M26 4L32 10H26V4Z" fill="rgba(255,255,255,0.3)" />
      {/* Text lines on document */}
      <rect x="14" y="14" width="14" height="2" rx="1" fill="rgba(255,255,255,0.5)" />
      <rect x="14" y="19" width="10" height="2" rx="1" fill="rgba(255,255,255,0.4)" />
      <rect x="14" y="24" width="12" height="2" rx="1" fill="rgba(255,255,255,0.35)" />
      {/* Sound waves */}
      <path
        d="M34 18C36 18 37 20 37 22C37 24 36 26 34 26"
        stroke="url(#logo-grad)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.8"
      />
      <path
        d="M36 14C40 14 42 18 42 22C42 26 40 30 36 30"
        stroke="url(#logo-grad)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.5"
      />
      {/* Microphone dot */}
      <circle cx="24" cy="40" r="4" fill="url(#logo-grad)" opacity="0.7" />
      <rect x="23" y="34" width="2" height="4" rx="1" fill="url(#logo-grad)" opacity="0.6" />
    </svg>
  );
}
