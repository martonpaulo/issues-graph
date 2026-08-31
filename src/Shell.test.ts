import { describe, expect, it, vi } from 'vitest'

import {
  createSettler,
  nextTrapIndex,
  overlayKeyAction,
  popupTriggerProps,
  restoresTriggerAfterOutsidePress,
} from './Shell'


describe('what a key press asks of an open overlay', () => {
  function press(
    key: string,
    modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
  ) {
    return { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers }
  }

  /* One table for both surfaces: the dialog acts on all three answers, the picker's panel on the
     first, and neither can end up reading Escape differently from the other. */
  it('dismisses on Escape and walks the controls on Tab', () => {
    expect(overlayKeyAction(press('Escape'))).toBe('close')
    expect(overlayKeyAction(press('Tab'))).toBe('focus-next')
    expect(overlayKeyAction(press('Tab', { shiftKey: true }))).toBe('focus-previous')
  })

  it('leaves the browser its own chords, so Ctrl+Tab still changes browser tab', () => {
    expect(overlayKeyAction(press('Tab', { ctrlKey: true }))).toBeNull()
    expect(overlayKeyAction(press('Tab', { metaKey: true }))).toBeNull()
    expect(overlayKeyAction(press('Tab', { altKey: true }))).toBeNull()
    expect(overlayKeyAction(press('Escape', { metaKey: true }))).toBeNull()
  })

  it('claims no other key, so what an overlay does not answer reaches the control', () => {
    for (const key of ['Enter', ' ', 'a', 'f', 'ArrowDown', 'Home']) {
      expect(overlayKeyAction(press(key)), key).toBeNull()
    }
  })
})

describe('where Tab goes inside an open dialog', () => {
  it('walks every control in turn and comes back to the first', () => {
    const walked: number[] = []
    let at = 0
    for (let press = 0; press < 3; press += 1) {
      at = nextTrapIndex(3, at, false)
      walked.push(at)
    }

    expect(walked).toEqual([1, 2, 0])
  })

  it('walks the same ring backwards on Shift+Tab', () => {
    const walked: number[] = []
    let at = 0
    for (let press = 0; press < 3; press += 1) {
      at = nextTrapIndex(3, at, true)
      walked.push(at)
    }

    expect(walked).toEqual([2, 1, 0])
  })

  /* A press arriving while the focus is still outside — on `<body>`, which the browser reports as
     no control at all — enters at the end the reader was heading for. */
  it('enters at the near end when the focus is outside the dialog', () => {
    expect(nextTrapIndex(3, -1, false)).toBe(0)
    expect(nextTrapIndex(3, -1, true)).toBe(2)
  })

  it('re-enters rather than running off the end when the focused control has gone', () => {
    expect(nextTrapIndex(2, 7, false)).toBe(0)
    expect(nextTrapIndex(2, 7, true)).toBe(1)
  })

  it('has nowhere to send a press in a dialog with nothing to focus', () => {
    expect(nextTrapIndex(0, -1, false)).toBe(-1)
    expect(nextTrapIndex(0, 0, true)).toBe(-1)
  })
})

describe('how a picker declares the panel it opens', () => {
  it('names the panel while it is open', () => {
    expect(popupTriggerProps(true, 'panel-1')).toEqual({
      'aria-haspopup': 'dialog',
      'aria-expanded': true,
      'aria-controls': 'panel-1',
    })
  })

  /* Pointing at an element that is not in the document says nothing to a screen reader, so a shut
     picker states only that it has a panel and that the panel is shut. */
  it('names nothing while it is shut', () => {
    expect(popupTriggerProps(false, 'panel-1')).toEqual({
      'aria-haspopup': 'dialog',
      'aria-expanded': false,
      'aria-controls': undefined,
    })
  })
})

describe('where the focus goes when a press outside closes a panel', () => {
  /* The canvas, the page behind it and the panel's own backdrop take no focus, so closing over one
     of them removes the control the reader was standing on and leaves them at the top of the
     document. That is the lost place the whole change is about. */
  it('takes the focus back when the press landed on nothing that can hold it', () => {
    expect(restoresTriggerAfterOutsidePress(true, false)).toBe(true)
  })

  it('leaves a control the reader pressed with the focus they gave it', () => {
    expect(restoresTriggerAfterOutsidePress(true, true)).toBe(false)
  })

  /* Somebody reading elsewhere on the page — the repository field, a card — has a place already,
     and a panel closing behind them is not a reason to move them to its trigger. */
  it('moves nobody who was standing outside the panel to begin with', () => {
    expect(restoresTriggerAfterOutsidePress(false, false)).toBe(false)
    expect(restoresTriggerAfterOutsidePress(false, true)).toBe(false)
  })
})


/* The picker's focus restoration is scheduled by the very close that ends the state it was
   scheduled in, so what owns the wait decides whether it ever runs. Owning it alongside the open
   state cancelled it on that transition and the reader was left on `<body>` anyway — the fault
   these cover. */
describe('the wait that outlives what scheduled it', () => {
  it('runs the task once the turn is over', () => {
    vi.useFakeTimers()
    try {
      const settler = createSettler()
      let ran = 0
      settler.after(() => (ran += 1))

      expect(ran).toBe(0)
      vi.runAllTimers()
      expect(ran).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is stopped by cancelling it and by nothing else', () => {
    vi.useFakeTimers()
    try {
      const settler = createSettler()
      let ran = 0
      settler.after(() => (ran += 1))
      settler.cancel()
      vi.runAllTimers()

      expect(ran).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps only the last call when a second press arrives before the first has settled', () => {
    vi.useFakeTimers()
    try {
      const settler = createSettler()
      const ran: string[] = []
      settler.after(() => ran.push('first'))
      settler.after(() => ran.push('second'))
      vi.runAllTimers()

      expect(ran).toEqual(['second'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels nothing after the task has already run, so a later wait still settles', () => {
    vi.useFakeTimers()
    try {
      const settler = createSettler()
      let ran = 0
      settler.after(() => (ran += 1))
      vi.runAllTimers()
      settler.cancel()
      settler.after(() => (ran += 1))
      vi.runAllTimers()

      expect(ran).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
