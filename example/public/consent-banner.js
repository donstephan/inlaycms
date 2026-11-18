const banner = document.getElementById('consent-banner')
const consent = window.inlay && window.inlay.consent

if (banner && consent) {
  const show = () => {
    banner.hidden = consent.get().decided
  }
  show()
  document.addEventListener('inlay:consent', show)
  banner.querySelector('[data-consent="accept"]').addEventListener('click', () => consent.grant('all'))
  banner.querySelector('[data-consent="decline"]').addEventListener('click', () => consent.revoke('all'))
}
