import { t } from '../../../core/messages/index.js'
import type { Renderable } from '../../../jsx/html.js'
import { Icon } from './icons.js'

export interface SheetProps {
  id: string
  title: string
  description?: string
  size?: 'lg'
  /** Open on page load: the server sent it back with values and problems, or `?sheet=` asked for it. */
  open?: boolean
  action: string
  enctype?: 'multipart/form-data'
  /** The main button's text. */
  submit: string
  children?: Renderable
}

export function Sheet({ id, title, description, size, open, action, enctype, submit, children }: SheetProps) {
  return (
    <dialog
      id={id}
      class={size === 'lg' ? 'sheet sheet-lg' : 'sheet'}
      data-sheet
      data-sheet-autoopen={open ? '' : undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={description === undefined ? undefined : `${id}-desc`}
    >
      <form method="post" action={action} enctype={enctype} class="sheet-panel">
        <header class="flex shrink-0 items-start gap-4 border-b border-base-300 px-5 py-4">
          <div class="min-w-0 flex-1">
            <h2 id={`${id}-title`} class="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {description === undefined ? null : (
              <p id={`${id}-desc`} class="text-sm text-base-content/70">
                {description}
              </p>
            )}
          </div>
          <button type="button" class="btn btn-ghost btn-sm btn-square" data-sheet-close aria-label={t('admin.sheet.close')}>
            <Icon name="x" />
          </button>
        </header>
        <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">{children}</div>
        <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-base-300 bg-base-100 px-5 py-3">
          <button type="button" class="btn btn-ghost" data-sheet-close>
            {t('admin.sheet.cancel')}
          </button>
          <button type="submit" class="btn btn-primary">
            {submit}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
