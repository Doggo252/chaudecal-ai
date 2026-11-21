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
export const IconExpand = (p: P) => (
  <Svg {...p}>
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </Svg>
)
export const IconShrink = (p: P) => (
  <Svg {...p}>
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </Svg>
)
export const IconPanel = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M14 4v16" />
  </Svg>
)
export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </Svg>
)
export const IconMic = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
)
export const IconSpeaker = (p: P) => (
  <Svg {...p}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
)
/** A screenshot: the corners of a capture frame around a lens. */
export const IconScreen = (p: P) => (
  <Svg {...p}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)
export const IconMenu = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)

// Marks for each assistant. Shapes tell them apart, so nobody has to remember a color.

/** Claude: a starburst. */
export const IconClaude = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" strokeWidth="2.2" />
  </Svg>
)
/** ChatGPT: three loops woven into a knot. */
export const IconChatgpt = (p: P) => (
  <Svg {...p}>
    <ellipse cx="12" cy="12" rx="3.6" ry="8.4" />
    <ellipse cx="12" cy="12" rx="3.6" ry="8.4" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="3.6" ry="8.4" transform="rotate(120 12 12)" />
  </Svg>
)
/** Local AI: a chip on this computer. */
export const IconLocal = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </Svg>
)
/** Auto: the app picks. */
export const IconAuto = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h3.5c4 0 5 10 9 10H20M17 14l3 3-3 3M4 17h3.5c1.6 0 2.7-1.6 3.6-3.6M13 9.6c.9-1.6 1.9-2.6 3.5-2.6H20M17 4l3 3-3 3" />
  </Svg>
)
/** Chats from claude.ai and chatgpt.com: a speech bubble. */
export const IconBubble = (p: P) => (
  <Svg {...p}>
    <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
  </Svg>
)
/** Artifacts: a page with a shape and lines, like a made thing. */
export const IconArtifact = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h3v3H8zM14 8.5h2.5M14 11h2.5M8 15h8.5M8 18h5" />
  </Svg>
)
