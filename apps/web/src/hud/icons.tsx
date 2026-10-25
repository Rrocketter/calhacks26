import type { ReactNode } from 'react';

// 16px line icons for card headers; stroke follows the text color.
const Svg = ({ children }: { children: ReactNode }) => (
  <svg className="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const MailIcon = () => (
  <Svg>
    <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
    <path d="m2.5 4.5 5.5 4 5.5-4" />
  </Svg>
);

export const CalendarIcon = () => (
  <Svg>
    <rect x="1.75" y="2.75" width="12.5" height="11" rx="1.5" />
    <path d="M1.75 6.25h12.5M5 1.5v2.5M11 1.5v2.5" />
  </Svg>
);

export const NoteIcon = () => (
  <Svg>
    <path d="M3.25 1.75h7l2.5 2.5v10h-9.5z" />
    <path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" />
  </Svg>
);

export const FileIcon = () => (
  <Svg>
    <path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" />
    <path d="M9.25 1.75v3.5h3.5" />
  </Svg>
);

export const ChatIcon = () => (
  <Svg>
    <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-3 2.75V11h0.5H3.5A1.5 1.5 0 0 1 2 9.5z" />
  </Svg>
);

export const SparkIcon = () => (
  <Svg>
    <path d="M8 1.75v3M8 11.25v3M1.75 8h3M11.25 8h3M3.6 3.6l2 2M10.4 10.4l2 2M3.6 12.4l2-2M10.4 5.6l2-2" />
  </Svg>
);
