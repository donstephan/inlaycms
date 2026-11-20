/** Copy buttons: `button[data-copy="<input id>"]` copies that field's value, then shows `data-copied` for two seconds. Without clipboard access it selects the text instead. */
export function initCopyButtons(): void {
  document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('button[data-copy]')
    if (!button) return
    const source = document.getElementById(button.dataset.copy ?? '')
    if (!(source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement)) return
    const select = () => {
      source.focus()
      source.select()
    }
    const confirm = () => {
      const original = button.dataset.original ?? button.textContent
      button.dataset.original = original
      button.textContent = button.dataset.copied ?? original
      clearTimeout(Number(button.dataset.timer))
      button.dataset.timer = String(
        setTimeout(() => {
          button.textContent = original
          delete button.dataset.original
        }, 2000),
      )
    }
    try {
      const write = navigator.clipboard?.writeText(source.value)
      if (!write) return select()
      write.then(confirm, select)
    } catch {
      select()
    }
  })
}
