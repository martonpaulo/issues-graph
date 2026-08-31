/**
 * The colour a label chip is drawn in, computed from the hex GitHub returns for that label.
 *
 * GitHub gives every label a six-digit hex and nothing else — no foreground, no guarantee that the
 * hex is legible against anything. Repositories pick those colours by eye, so the set includes
 * `ffffff`, `000000` and every unreadable middle. A chip therefore cannot paint the hex directly:
 * it has to derive a pair that is legible whatever the repository chose.
 *
 * The pair computed here is **self-contained and opaque**, which is the property that makes it
 * provable. A chip tinted with alpha would composite against whichever card fill sits behind it —
 * `ready`, `blocked`, `attention` — and its contrast would then depend on state the chip has no
 * access to. These two colours are compared only with each other, so the ratio asserted in the
 * tests is the ratio the browser draws, on every card.
 *
 * https://docs.github.com/en/rest/issues/labels — `color` is the six-digit hex, without a `#`.
 */

/** WCAG 2.2 normal-text minimum. A chip is 10px, which is normal text, so it owes 4.5:1. */
export const AA_NORMAL_TEXT = 4.5

export interface ChipPalette {
  /** Opaque background. Always light: the theme is light-only (`color-scheme: light`). */
  background: string
  /** Text colour, guaranteed at least `AA_NORMAL_TEXT` against `background`. */
  foreground: string
  /** Edge of the pill. Non-text, so it owes nothing, and it only has to be visible. */
  border: string
}

/** How light the chip's background is. Light enough that a dark foreground always exists. */
const BACKGROUND_LIGHTNESS = 0.94
/** Saturation is capped so a fully saturated label does not shout from the tint. */
const BACKGROUND_SATURATION_CAP = 0.7
const BORDER_LIGHTNESS = 0.8
/**
 * Where the search for a foreground starts, and how finely it steps. Starting mid-dark keeps the
 * label's own hue recognizable instead of collapsing every chip to near-black.
 */
const FOREGROUND_START_LIGHTNESS = 0.4
const FOREGROUND_STEP = 0.01

type Rgb = readonly [number, number, number]

function parseHex(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null
  return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** WCAG 2.2 relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.2 contrast ratio between two opaque colours. */
export function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

interface Hsl {
  hue: number
  saturation: number
  lightness: number
}

function toHsl([r, g, b]: Rgb): Hsl {
  const [red, green, blue] = [r / 255, g / 255, b / 255]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  const span = max - min
  if (span === 0) return { hue: 0, saturation: 0, lightness }

  const saturation = span / (1 - Math.abs(2 * lightness - 1))
  const hue =
    max === red
      ? ((green - blue) / span + (green < blue ? 6 : 0)) / 6
      : max === green
        ? ((blue - red) / span + 2) / 6
        : ((red - green) / span + 4) / 6
  return { hue, saturation, lightness }
}

function fromHsl({ hue, saturation, lightness }: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const secondary = chroma * (1 - Math.abs(((hue * 6) % 2) - 1))
  const base = lightness - chroma / 2
  const sector = Math.floor(hue * 6) % 6
  const [r, g, b] = (
    [
      [chroma, secondary, 0],
      [secondary, chroma, 0],
      [0, chroma, secondary],
      [0, secondary, chroma],
      [secondary, 0, chroma],
      [chroma, 0, secondary],
    ] as const
  )[sector]
  // Rounded here rather than at serialization: the contrast searched for below has to be the
  // contrast of the colour actually emitted, and a half-step of rounding is enough to drop a pair
  // that measured 4.50 as floats to 4.49 as hex.
  return [(r + base) * 255, (g + base) * 255, (b + base) * 255].map(Math.round) as unknown as Rgb
}

/**
 * The chip's colours for one GitHub label hex, or null when the payload does not carry a usable
 * one — a hand-written shared link or an older cached copy. A null falls back to the stylesheet's
 * own chip treatment, which `styles.test.ts` already holds at AA over every card fill.
 *
 * The foreground is found by darkening the label's own hue until it clears AA against the tint.
 * The search always terminates: at lightness 0 the colour is black, which is roughly 17:1 against
 * a background this light, so the loop's floor is never the answer by accident.
 */
export function chipPalette(color: string): ChipPalette | null {
  const parsed = parseHex(color)
  if (parsed === null) return null

  const { hue, saturation } = toHsl(parsed)
  const background = fromHsl({
    hue,
    saturation: Math.min(saturation, BACKGROUND_SATURATION_CAP),
    lightness: BACKGROUND_LIGHTNESS,
  })
  const border = fromHsl({ hue, saturation, lightness: BORDER_LIGHTNESS })

  let foreground = fromHsl({ hue, saturation, lightness: FOREGROUND_START_LIGHTNESS })
  for (
    let lightness = FOREGROUND_START_LIGHTNESS;
    lightness >= 0 && contrast(foreground, background) < AA_NORMAL_TEXT;
    lightness -= FOREGROUND_STEP
  ) {
    foreground = fromHsl({ hue, saturation, lightness: Math.max(0, lightness) })
  }

  return {
    background: toHex(background),
    foreground: toHex(foreground),
    border: toHex(border),
  }
}
