import 'htmx.org'
import './picker.js'
import { initDataTables, initDropdowns } from './data-table.js'
import { initPublishDialog } from './publish.js'
import { initSheets } from './sheet.js'
import { initGlobalSearch } from './search.js'
import { localiseTimes } from './time.js'

document.addEventListener('DOMContentLoaded', () => {
  localiseTimes(document)
  initDataTables(document)
  initDropdowns(document)
  initGlobalSearch(document)
  initPublishDialog(document)
  initSheets(document)
})
document.addEventListener('htmx:afterSwap', (event) => {
  const target = event.target
  localiseTimes(target instanceof Element ? target : document)
  initDataTables(target instanceof Element ? target : document)
})
