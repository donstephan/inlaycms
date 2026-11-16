/**
 * Publishing and unpublishing in `dialog#publish-dialog`, so you stay on the page you were on. Every publish button
 * (`[data-publish-dialog]`) links to the publish page, which still works without JS; with JS the page's
 * `#publish-panel` is loaded into the dialog instead, and its form is posted from there. Closing the dialog after
 * something was published brings the page underneath up to date: in the editor by refreshing its `[data-refresh]`
 * parts, so unsaved edits stay, and elsewhere by reloading it.
 *
 * In the editor, Save and publish saves in the background and then opens the dialog, without leaving the page.
 */

const PANEL = 'publish-panel'
const BODY = 'publish-dialog-body'

export interface PublishDialogOptions {
  /** Reloads the page after a publish, outside the editor; `location.reload()` by default. */
  reload?: () => void
}

const bound = new WeakSet<Element>()

/** Replaces each `[data-refresh]` element of `doc` with the one with the same id in `page`. */
function refreshFrom(doc: Document, page: Document): void {
  for (const old of doc.querySelectorAll<HTMLElement>('[data-refresh][id]')) {
    const fresh = page.getElementById(old.id)
    if (fresh !== null) old.replaceWith(doc.importNode(fresh, true))
  }
}

/** Marks `form` as sent with JS, so a Save and publish that works comes back to the editor (`?review=publish`). */
function flagDialog(form: HTMLFormElement): void {
  if (form.querySelector('input[name="_dialog"]') !== null) return
  const flag = form.ownerDocument.createElement('input')
  flag.type = 'hidden'
  flag.name = '_dialog'
  flag.value = '1'
  form.append(flag)
}

/** `form`'s values as the query or body of a request, as pressing `submitter` would send them. */
function valuesOf(form: HTMLFormElement, submitter?: HTMLElement): URLSearchParams {
  const params = new URLSearchParams()
  for (const [name, value] of new FormData(form)) if (typeof value === 'string') params.append(name, value)
  if (submitter instanceof HTMLButtonElement && submitter.name !== '') params.append(submitter.name, submitter.value)
  return params
}

/** Wires up the publish dialog for `doc`, and opens it straight away when the page asks for it (after Save and publish). */
export function initPublishDialog(doc: Document, opts: PublishDialogOptions = {}): void {
  const found = doc.getElementById('publish-dialog')
  if (!(found instanceof HTMLDialogElement) || bound.has(found)) return
  bound.add(found)
  const dialog = found
  const view = doc.defaultView
  const body = doc.getElementById(BODY)
  const heading = doc.getElementById('publish-dialog-title')
  const loading = dialog.querySelector<HTMLElement>('[data-publish-loading]')
  const reload = opts.reload ?? (() => view?.location.reload())
  // `posting`: a publish was sent and hasn't answered, so closing now may still leave the page out of date.
  let published = false
  let posting = false
  let request = 0

  const setState = (state: string) => {
    dialog.dataset.state = state
    for (const icon of dialog.querySelectorAll<HTMLElement>('[data-state-icon]')) icon.hidden = icon.dataset.stateIcon !== state
  }

  /** Shows `html`'s panel in the dialog; `false` when it has none (an error page, a login page). */
  const show = (html: string): boolean => {
    const panel = new DOMParser().parseFromString(html, 'text/html').getElementById(PANEL)
    if (panel === null || body === null) return false
    const state = panel.dataset.state ?? ''
    if (heading !== null) heading.textContent = panel.dataset.title ?? ''
    for (const link of panel.querySelectorAll<HTMLElement>('[data-dialog-label]')) link.textContent = link.dataset.dialogLabel ?? ''
    body.replaceChildren(doc.importNode(panel, true))
    if (loading !== null) loading.hidden = true
    setState(state)
    if (state === 'done') published = true
    const focus = body.querySelector<HTMLElement>('form button[type="submit"]') ?? body.querySelector<HTMLElement>('a, button')
    focus?.focus()
    return true
  }

  /** Brings the page up to date after a publish. The editor keeps its form, and with it any unsaved edits. */
  const catchUp = () => {
    if (doc.getElementById('editor-form') === null || view === null) return reload()
    fetch(view.location.href, { headers: { accept: 'text/html' } })
      .then((res) => res.text())
      .then((html) => refreshFrom(doc, new DOMParser().parseFromString(html, 'text/html')), reload)
  }

  /**
   * Save and publish: posts the editor form in the background. A save that worked comes back as the editor asking for
   * the review (`[data-publish-open]`); then the page catches up with the save and the dialog opens on the review.
   * Anything else (problems in the form, someone else's save, no answer) submits the form the ordinary way, which
   * shows it on the page as before.
   */
  const saveThenOpen = (form: HTMLFormElement, button: HTMLButtonElement) => {
    const values = valuesOf(form, button)
    values.set('_dialog', '1')
    button.disabled = true
    const fallBack = () => {
      button.disabled = false
      flagDialog(form)
      form.requestSubmit(button)
    }
    fetch(form.action, { method: 'POST', body: values, headers: { accept: 'text/html' } })
      .then((res) => res.text())
      .then((html) => {
        const page = new DOMParser().parseFromString(html, 'text/html')
        const review = page.querySelector<HTMLElement>('[data-publish-open]')?.dataset.publishOpen
        const base = page.querySelector<HTMLInputElement>('#editor-form input[name="base"]')?.value
        const mine = form.querySelector<HTMLInputElement>('input[name="base"]')
        if (review === undefined || base === undefined || mine === null) return fallBack()
        mine.value = base
        const state = page.getElementById('save-state')
        if (state !== null) doc.getElementById('save-state')?.replaceWith(doc.importNode(state, true))
        refreshFrom(doc, page)
        form.dispatchEvent(new CustomEvent('inlay:saved', { bubbles: true }))
        button.disabled = false
        open(review)
      }, fallBack)
  }

  /** Opens the dialog on the review at `url`; if it can't be loaded, goes to the page itself. */
  const open = (url: string) => {
    const mine = ++request
    body?.replaceChildren()
    if (loading !== null) loading.hidden = false
    setState('')
    if (!dialog.open) {
      published = false
      dialog.showModal()
    }
    const fallBack = () => {
      if (mine !== request) return
      dialog.close()
      view?.location.assign(url)
    }
    fetch(url, { headers: { accept: 'text/html' } })
      .then((res) => res.text())
      .then((html) => {
        if (mine === request && !show(html)) fallBack()
      }, fallBack)
  }

  /** Posts the dialog's confirm form; if the answer isn't a panel, submits it the ordinary way. */
  const post = (form: HTMLFormElement) => {
    const mine = ++request
    posting = true
    const values = valuesOf(form)
    // Tells the server this is the dialog, which wants the "done" panel rather than being sent back to the page.
    values.set('_dialog', '1')
    for (const control of form.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')) {
      if (control instanceof HTMLButtonElement) control.disabled = true
      else control.setAttribute('aria-disabled', 'true')
    }
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (submit !== null && form.dataset.busyLabel !== undefined) submit.textContent = form.dataset.busyLabel
    const fallBack = () => {
      if (mine === request) form.submit()
    }
    fetch(form.action, { method: 'POST', body: values, headers: { accept: 'text/html' } })
      .finally(() => {
        posting = false
      })
      .then((res) => res.text())
      .then((html) => {
        if (mine === request && !show(html)) fallBack()
      }, fallBack)
  }

  doc.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !dialog.isConnected) return
    const trigger = event.target.closest<HTMLElement>('[data-publish-dialog]')
    if (trigger === null || dialog.contains(trigger)) return
    if (trigger instanceof HTMLAnchorElement) {
      event.preventDefault()
      trigger.closest<HTMLDetailsElement>('details.dropdown')?.removeAttribute('open')
      open(trigger.href)
      return
    }
    if (!(trigger instanceof HTMLButtonElement) || trigger.form === null) return
    const form = trigger.form
    if (trigger.name === '_action') {
      // A page showing a failed save is submitted the ordinary way, which clears its messages.
      if (form.hasAttribute('data-save-errors')) return flagDialog(form)
      event.preventDefault()
      saveThenOpen(form, trigger)
      return
    }
    event.preventDefault()
    const action = new URL(trigger.getAttribute('formaction') ?? form.getAttribute('action') ?? '', doc.baseURI)
    action.search = valuesOf(form).toString()
    open(action.href)
  })

  body?.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const control = event.target.closest<HTMLElement>('a, button')
    if (control === null) return
    if (control.getAttribute('aria-disabled') === 'true') {
      event.preventDefault()
      return
    }
    if (control.hasAttribute('data-dialog-cancel')) {
      event.preventDefault()
      dialog.close()
      return
    }
    // "See the latest changes" reloads the review in the dialog.
    if (control instanceof HTMLAnchorElement && new URL(control.href).pathname === '/admin/publish') {
      event.preventDefault()
      open(control.href)
    }
  })

  body?.addEventListener('submit', (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || form.method !== 'post') return
    event.preventDefault()
    post(form)
  })

  dialog.addEventListener('close', () => {
    request++
    if (published || posting) catchUp()
  })

  // After Save and publish: open the review, and take `review` out of the address so reloading doesn't open it again.
  const asked = doc.querySelector<HTMLElement>('[data-publish-open]')
  const url = asked?.dataset.publishOpen
  if (asked == null || url === undefined) return
  asked.remove()
  if (view !== null) {
    const here = new URL(view.location.href)
    here.searchParams.delete('review')
    view.history.replaceState(view.history.state, '', here.href)
  }
  open(url)
}
