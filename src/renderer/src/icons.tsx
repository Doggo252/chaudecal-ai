import type { ReactNode } from 'react'

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

type P = { size?: number }

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
)
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Svg>
)
export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
  </Svg>
)
export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
)
export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
)
export const IconSwitch = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </Svg>
)
export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </Svg>
)
export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.500 5.600 12 3z" />
  </Svg>
)
export const IconColumns = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M9 5v14M15 5v14" />
  </Svg>
)
export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </Svg>
)
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="m14 6-6 6 6 6" />
  </Svg>
)
export const IconForward = (p: P) => (
  <Svg {...p}>
    <path d="m10 6 6 6-6 6" />
  </Svg>
)
export const IconReload = (p: P) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" />
  </Svg>
)
export const IconHome = (p: P) => (
  <Svg {...p}>
    <path d="M4 11.500 12 5l8 6.500V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" />
  </Svg>
)
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
)
export const IconPin = (p: P) => (
  <Svg {...p}>
    <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />
  </Svg>
)
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.500 4.500 4.500L19 7.500" />
  </Svg>
)
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Svg>
)
export const IconRetry = (p: P) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 1 0 2.600-5.900M4 4v5h5" />
  </Svg>
)
export const IconBook = (p: P) => (
  <Svg {...p}>
    <path d="M5 5.500A1.500 1.500 0 0 1 6.500 4H19v14H6.500A1.500 1.500 0 0 0 5 19.500zM5 19.500A1.500 1.500 0 0 0 6.500 21H19" />
  </Svg>
)
export const IconSync = (p: P) => (
  <Svg {...p}>
    <path d="M17 3v4h-4M7 21v-4h4" />
    <path d="M19.500 11A7.500 7.500 0 0 0 6 7l-1 1M4.500 13A7.500 7.500 0 0 0 18 17l1-1" />
  </Svg>
)
export const IconClip = (p: P) => (
  <Svg {...p}>
    <path d="M20 11.5 12.5 19a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />
  </Svg>
)
export const IconBranch = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="5" r="2" />
    <circle cx="7" cy="19" r="2" />
    <circle cx="17" cy="9" r="2" />
    <path d="M7 7v10M17 11c0 3-3 4-10 4" />
  </Svg>
)
export const IconOpinion = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h11a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-4 3v-3H4z" />
    <path d="M20 9v6a2 2 0 0 1-2 2h-1v3l-3-3" />
  </Svg>
)
export const IconFile = (p: P) => (
  <Svg {...p}>
    <path d="M7 3h7l5 5v13H7z" />
    <path d="M14 3v5h5" />
  </Svg>
)
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
  </Svg>
)
export const IconComputer = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Svg>
)
