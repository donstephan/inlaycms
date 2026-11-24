import 'htmx.org'
import './picker.js'
import { initDataTables, initDropdowns } from './data-table.js'
import { initCopyButtons } from './copy.js'
import { initLengthCounters } from './length.js'
import { initPublishDialog } from './publish.js'
import { initSheets } from './sheet.js'
import { initGlobalSearch } from './search.js'
import { keepNavScroll } from './nav-scroll.js'
import { initNotice } from './notice.js'
import { localiseTimes } from './time.js'

keepNavScroll()
document.addEventListener('DOMContentLoaded', () => {
  localiseTimes(document)
  initDataTables(document)
  initLengthCounters(document)
  initDropdowns(document)
  initGlobalSearch(document)
  initPublishDialog(document)
  initSheets(document)
  initNotice()
  initCopyButtons()
})
document.addEventListener('htmx:afterSwap', (event) => {
  const target = event.target
  localiseTimes(target instanceof Element ? target : document)
  initDataTables(target instanceof Element ? target : document)
  initLengthCounters(target instanceof Element ? target : document)
})
