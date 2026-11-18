const key = 'example-visits'
let count = 0
try {
  count = Number(sessionStorage.getItem(key)) || 0
  count += 1
  sessionStorage.setItem(key, String(count))
} catch {
  count = 1
}
console.log('Pages opened in this session: ' + count)
