/**
 * One place for the inline glyphs. They are inline SVG rather than an icon dependency because the
 * whole viewer is four small modules and a font or sprite would be the largest thing it ships.
 *
 * Every icon is decorative: each control that uses one also carries its own accessible name.
 */
export type IconName =
  | 'graph'
  | 'external'
  | 'fit'
  | 'reload'
  | 'eye'
  | 'eye-off'
  | 'close'
  | 'search'
  | 'tag'
  | 'clock'
  | 'link'

const PATHS: Record<IconName, React.ReactNode> = {
  graph: (
    <>
      <circle cx="8" cy="3.2" r="2" />
      <circle cx="3.4" cy="12.4" r="2" />
      <circle cx="12.6" cy="12.4" r="2" />
      <path d="M6.9 5 4.5 10.5M9.1 5l2.4 5.5M5.4 12.4h5.2" />
    </>
  ),
  link: (
    <>
      <path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.4-2.4a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
      <path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
    </>
  ),
  external: (
    <>
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </>
  ),
  fit: (
    <>
      <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6" />
      <path d="M10 2.5h2.5a1 1 0 0 1 1 1V6" />
      <path d="M13.5 10v2.5a1 1 0 0 1-1 1H10" />
      <path d="M6 13.5H3.5a1 1 0 0 1-1-1V10" />
    </>
  ),
  reload: (
    <>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" />
      <path d="M13.4 2.6v3.2h-3.2" />
    </>
  ),
  eye: (
    <>
      <path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8Z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M6.3 4.1A6.4 6.4 0 0 1 8 3.8c4 0 6.4 4.2 6.4 4.2a12 12 0 0 1-2.2 2.7" />
      <path d="M9.9 9.9a2 2 0 0 1-2.8-2.8" />
      <path d="M4.2 5.3A12 12 0 0 0 1.6 8s2.4 4.2 6.4 4.2a6.3 6.3 0 0 0 2.4-.5" />
      <path d="m2.6 2.6 10.8 10.8" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  tag: (
    <>
      <path d="M8.3 2.5H13a.5.5 0 0 1 .5.5v4.7a1 1 0 0 1-.3.7l-5 5a1 1 0 0 1-1.4 0L2.6 9.2a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 .7-.3Z" />
      <circle cx="10.6" cy="5.4" r=".9" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </>
  ),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="m10.4 10.4 3 3" />
    </>
  ),
}

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
