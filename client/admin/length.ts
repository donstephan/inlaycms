const bound = new WeakSet<Element>()

/** Keeps each `[data-length-for]` counter in step with its control, and shows its hint past the suggested length. */
export function initLengthCounters(root: ParentNode): void {
  for (const counter of root.querySelectorAll('[data-length-for]')) {
    if (bound.has(counter)) continue
    const control = counter.ownerDocument.getElementById(counter.getAttribute('data-length-for') ?? '')
    const suggested = Number(counter.getAttribute('data-suggested-length'))
    const label = counter.getAttribute('data-label')
    const count = counter.querySelector('[data-length-count]')
    const hint = counter.querySelector('[data-length-hint]')
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) || label === null || count === null || !Number.isFinite(suggested)) continue
    bound.add(counter)
    const update = () => {
      const length = control.value.length
      count.textContent = label.replace('{count}', () => String(length))
      hint?.toggleAttribute('hidden', length <= suggested)
    }
    control.addEventListener('input', update)
  }
}
