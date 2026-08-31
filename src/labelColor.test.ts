import { describe, expect, it } from 'vitest'

import { AA_NORMAL_TEXT, chipPalette, contrast } from './labelColor'

const rgb = (hex: string) =>
  [0, 2, 4].map((at) => parseInt(hex.slice(1).slice(at, at + 2), 16)) as unknown as readonly [
    number,
    number,
    number,
  ]

const ratio = (palette: { foreground: string; background: string }) =>
  contrast(rgb(palette.foreground), rgb(palette.background))

describe('contrast arithmetic', () => {
  it('agrees with the two anchors WCAG defines', () => {
    expect(Math.round(contrast(rgb('#000000'), rgb('#ffffff')) * 100) / 100).toBe(21)
    expect(Math.round(contrast(rgb('#777777'), rgb('#ffffff')) * 100) / 100).toBe(4.48)
  })
})

describe('chipPalette', () => {
  /**
   * The colours GitHub ships on a new repository, which is what an arbitrary backlog is mostly
   * labelled with. None of them is chosen for legibility against anything.
   */
  const githubDefaults = [
    'd73a4a', // bug
    '0075ca', // documentation
    'cfd3d7', // duplicate
    'a2eeef', // enhancement
    '7057ff', // good first issue
    '008672', // help wanted
    'e4e669', // invalid
    'd876e3', // question
    'ffffff', // wontfix
  ]

  it.each(githubDefaults)('holds %s at AA', (color) => {
    const palette = chipPalette(color)!
    expect(palette).not.toBeNull()
    expect(ratio(palette)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  /**
   * The corners of the sRGB cube bound the luminance of every colour inside it, so a pair that
   * holds at all eight holds for a hex nobody has picked yet. `ffffff` and `000000` are the two
   * that a naive "use the label colour as the text" would fail hardest.
   */
  it.each(['000000', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff', 'ffffff'])(
    'holds the sRGB corner %s at AA',
    (color) => {
      expect(ratio(chipPalette(color)!)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    },
  )

  it('holds every hex in a deterministic sweep of the space at AA', () => {
    const failures: string[] = []
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const color = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
          const palette = chipPalette(color)!
          if (ratio(palette) < AA_NORMAL_TEXT) failures.push(color)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('keeps the background light and the foreground dark, whatever the label is', () => {
    // The theme is light-only, so a chip that inverted on a dark label would read as a hole in the
    // card rather than as a chip.
    for (const color of ['000000', 'ffffff', 'd73a4a', '0075ca']) {
      const palette = chipPalette(color)!
      expect(ratio({ foreground: palette.background, background: '#ffffff' })).toBeLessThan(2)
      expect(ratio({ foreground: palette.foreground, background: '#ffffff' })).toBeGreaterThan(4)
    }
  })

  it('keeps the label\'s hue rather than collapsing every chip to one grey', () => {
    const red = chipPalette('d73a4a')!
    const blue = chipPalette('0075ca')!
    expect(red.background).not.toBe(blue.background)
    expect(red.foreground).not.toBe(blue.foreground)
    expect(red.border).not.toBe(blue.border)
  })

  it('is deterministic and accepts the forms a payload can carry', () => {
    expect(chipPalette('d73a4a')).toEqual(chipPalette('d73a4a'))
    expect(chipPalette('#d73a4a')).toEqual(chipPalette('d73a4a'))
    expect(chipPalette('D73A4A')).toEqual(chipPalette('d73a4a'))
    expect(chipPalette(' d73a4a ')).toEqual(chipPalette('d73a4a'))
  })

  /**
   * A shared link is a hand-writable string and an older cached copy may predate the field, so a
   * colour is not guaranteed to be a colour. Null hands the chip back to the stylesheet, which
   * `styles.test.ts` already holds at AA over every card fill.
   */
  it('returns null rather than a colour it cannot compute', () => {
    for (const bad of ['', 'red', 'f00', '#12345', 'ggggpp', '12345678', 'rgb(1,2,3)']) {
      expect(chipPalette(bad)).toBeNull()
    }
  })
})
