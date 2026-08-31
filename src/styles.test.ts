import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The theme is one light palette held in `styles.css`, and several of its roles are 10-13px text,
 * which WCAG 2.2 counts as normal text and owes 4.5:1. Two things make that easy to break by
 * accident: a token is reused on surfaces its author never looked at, and most of the card's own
 * text is tinted with `opacity` rather than a colour, so the rendered pair exists nowhere in the
 * stylesheet. This suite recomputes both from the stylesheet itself, so a token edit that drops a
 * pair below the minimum fails here rather than in an audit of the deployed page.
 */

const AA_NORMAL_TEXT = 4.5

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8')

/** Declaration blocks, keyed by their verbatim selector text, with comments stripped first. */
const rules = new Map<string, string>()
for (const [, selector, body] of css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  rules.set(selector.trim().replace(/\s+/g, ' '), body)
}

function lookup(selector: string, property: string): string | null {
  const body = rules.get(selector)
  if (body === undefined) throw new Error(`no rule for ${selector}`)
  const found = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`).exec(body)
  return found === null ? null : found[1].trim()
}

function declaration(selector: string, property: string): string {
  const found = lookup(selector, property)
  if (found === null) throw new Error(`no ${property} in ${selector}`)
  return found
}

const token = (name: string) => declaration(':root', `--${name}`)
const opacity = (selector: string) => Number(declaration(selector, 'opacity'))

/** A `var(--name)` reference resolved against `:root`, or the colour itself when it is literal. */
function resolve(color: string): string {
  const name = /var\(--([a-z-]+)\)/.exec(color)
  return name === null ? color : token(name[1])
}

/** The rendered pair of a rule that paints both halves itself, read rather than copied. */
const painted = (selector: string) =>
  [resolve(declaration(selector, 'color')), resolve(declaration(selector, 'background'))] as const

type Rgb = readonly [number, number, number]

function rgb(color: string): Rgb {
  const hex = color.trim().replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a six-digit hex colour: ${color}`)
  return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb
}

/** Alpha compositing in sRGB, which is what the browser does before it draws the pixel. */
function over(fg: string, bg: string, alpha: number): string {
  const [f, b] = [rgb(fg), rgb(bg)]
  return `#${f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

/** `color-mix(in srgb, <colour> <n>%, transparent)` drawn over `bg` — the one form this file uses. */
function mix(declaration: string, bg: string, resolve: (color: string) => string): string {
  const parsed = /color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*transparent\)/.exec(declaration)
  if (parsed === null) throw new Error(`unrecognised colour mix: ${declaration}`)
  return over(resolve(parsed[1]), bg, Number(parsed[2]) / 100)
}

/** WCAG 2.2 relative luminance and contrast ratio. */
function luminance(color: string): number {
  const channels = rgb(color).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

const round = (ratio: number) => Math.round(ratio * 100) / 100

describe('contrast arithmetic', () => {
  it('agrees with the two anchors WCAG defines', () => {
    expect(round(contrast('#000000', '#ffffff'))).toBe(21)
    expect(round(contrast('#777777', '#ffffff'))).toBe(4.48)
  })

  it('reproduces the ratios axe-core measured on the deployed page before #22', () => {
    // https://github.com/martonpaulo/issues-graph/issues/22#issuecomment-5476413651 — measured by
    // axe-core in Chrome as 4.17 and 4.22; the hundredth is rounding, not disagreement.
    expect(round(contrast('#ffffff', '#4c6fff'))).toBe(4.18)
    expect(round(contrast('#6b7684', '#f3f5f8'))).toBe(4.23)
  })

  it('composites an alpha the way a browser does', () => {
    expect(over('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(over('#ffffff', '#000000', 0)).toBe('#000000')
  })
})

/**
 * Every pair where a token is drawn as normal-size text directly on another token. The right-hand
 * side is the surface the selector actually paints on, not the nearest token by name.
 */
const pairs: ReadonlyArray<readonly [string, string, string]> = [
  ['body text on the canvas', token('text'), token('bg')],
  ['body text on a panel', token('text'), token('surface')],
  ['muted text on the canvas', token('muted'), token('bg')],
  ['muted text on a panel', token('muted'), token('surface')],
  ['muted text on an accent fill', token('muted'), token('accent-soft')],
  ['primary button label', '#ffffff', token('accent')],
  ['primary button label, hovered', '#ffffff', token('accent-strong')],
  // A disabled control is exempt from 1.4.3, but #22 asked for it anyway: the state is reachable
  // (an unchanged token, a saved copy that cannot be taken) and its label still has to be read.
  ['disabled button label', ...painted('.button:disabled')],
  ['disabled primary button label', ...painted('.button--primary:disabled')],
  ['accent text on a panel', token('accent'), token('surface')],
  ['accent text on its own soft fill', token('accent'), token('accent-soft')],
  ['the label picker while it is on', declaration('.iconbutton.is-highlighting', 'color'), token('highlight-soft')],
  // The info panel's warning paints both halves itself rather than inheriting the panel's, so the
  // pair is read off the rule instead of assembled from the tokens it happens to name.
  ['the canvas warning', ...painted('.info__warn')],
]

describe('token pairs', () => {
  it.each(pairs)('%s meets AA for normal text', (_role, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })
})

/**
 * The card's own text. Its colour is `--text` inherited from the body in every state; what varies
 * is the fill underneath and the `opacity` the role is tinted with, so the rendered pair has to be
 * composited before it can be checked. Both halves are read from the stylesheet, so a new state or
 * a re-tinted role is covered without editing this list.
 */
const stateFills = [...rules.keys()]
  .filter((selector) => /^\.card--[a-z-]+$/.test(selector))
  // The same prefix also carries modifiers — external, selected, dimmed — which restyle a card
  // without giving it a fill. A state is exactly the ones that name a fill token.
  .map((selector) => [selector, lookup(selector, 'background')] as const)
  .filter(([, background]) => background?.startsWith('var(--') === true)
  .map(([selector, background]) => {
    const name = /var\(--([a-z-]+)\)/.exec(background as string)
    if (name === null) throw new Error(`unresolved fill on ${selector}`)
    return [selector.replace('.card--', ''), token(name[1])] as const
  })

const cardRoles: ReadonlyArray<readonly [string, number]> = [
  ['the title', 1],
  ['the issue number', opacity('.card__number')],
  ['the repository name', opacity('.card__repo')],
  ['the sub-issue count', opacity('.card__progress')],
  ['the state word', opacity('.card__state')],
]

describe('card text over every state fill', () => {
  it('found every state fill the stylesheet defines', () => {
    expect(stateFills.map(([state]) => state).sort()).toEqual([
      'attention',
      'blocked',
      'completed',
      'in-progress',
      'in-review',
      'not-planned',
      'ready',
      'unassigned',
    ])
  })

  const text = token('text')

  it.each(stateFills)('%s carries all of its text at AA', (_state, fill) => {
    for (const [, alpha] of cardRoles) {
      expect(contrast(over(text, fill, alpha), fill)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    }
  })

  it.each(stateFills)('%s carries both chip kinds at AA', (_state, fill) => {
    const resolve = (color: string) => (color === 'currentColor' ? text : color)

    // A filled chip tints the whole element, background included, so the glyph and the fill behind
    // it are both composited at the element's own opacity before they are compared.
    const chipAlpha = opacity('.chip')
    const chipFill = mix(declaration('.chip', 'background'), fill, resolve)
    expect(
      contrast(over(text, fill, chipAlpha), over(chipFill, fill, chipAlpha)),
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)

    // An empty slot has no fill of its own: it is the card's.
    expect(contrast(over(text, fill, opacity('.chip--empty')), fill)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    )
  })

  it.each(stateFills)('%s keeps the hovered card actions legible', (_state, fill) => {
    const button = mix(declaration('.card__actions .iconbutton', 'background'), fill, resolve)
    expect(contrast(token('muted'), button)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })
})

/** Group labels sit on a translucent frame fill drawn over the canvas, never over a card. */
describe('group labels', () => {
  const frames: ReadonlyArray<readonly [string, string]> = [
    ['.group--chain', '.group--chain .group__label'],
    ['.group--breakdown', '.group--breakdown .group__label'],
  ]

  it.each(frames)('%s labels its frame at AA', (frame, label) => {
    const fill = mix(declaration(frame, 'background'), token('bg'), resolve)
    expect(contrast(declaration(label, 'color'), fill)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it('keeps the default label readable on a selected frame', () => {
    const fill = mix(declaration('.group--selected', 'background'), token('bg'), resolve)
    expect(contrast(token('muted'), fill)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })
})
