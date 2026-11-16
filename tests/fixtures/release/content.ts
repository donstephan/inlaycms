import { defineContent } from 'inlaycms/site'

export const content = [
  defineContent('home', {
    edition: 1,
    content: {
      en: { fields: { title: 'Hello', picture: { file: new URL('./assets/pic.png', import.meta.url), alt: 'A picture' } } },
    },
  }),
]
