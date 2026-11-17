import { defineContent, defineEntries } from 'inlaycms/site'
import tablesAndImages from './posts/tables-and-images.md'

const HERO = new URL('./assets/hero.jpg', import.meta.url)

export const content = [
  defineContent('home', {
    edition: 1,
    content: {
      en: {
        fields: { title: 'Home' },
        slots: {
          hero: {
            headline: 'Websites that stay simple',
            intro: 'An example site built with Inlay.',
            image: { file: HERO, alt: 'A blue and orange gradient' },
            cta: { url: '/blog', text: 'Read the blog' },
          },
          features: {
            items: [
              { title: 'Fast', text: 'Pages are cached and served quickly.' },
              { title: 'Safe', text: 'Everything you type is escaped for you.' },
              { title: 'Multilingual', text: 'English and Spanish out of the box.' },
            ],
          },
          testimonials: false,
        },
      },
      es: {
        fields: { title: 'Inicio' },
        slots: {
          hero: {
            headline: 'Sitios web que siguen siendo simples',
            intro: 'Un sitio de ejemplo creado con Inlay.',
            image: { file: HERO, alt: 'Un degradado azul y naranja' },
            cta: { url: '/blog', text: 'Leer el blog' },
          },
          features: {
            items: [
              { title: 'Rapido', text: 'Las paginas se guardan en cache.' },
              { title: 'Seguro', text: 'Todo lo que escribes se protege.' },
            ],
          },
          testimonials: false,
        },
      },
    },
  }),
  defineContent('about', {
    edition: 1,
    content: { en: { fields: { title: 'About us', body: 'We build **websites** for people who write.' } } },
  }),
  defineContent('blog', { edition: 1, content: { en: { fields: { title: 'Blog' } } } }),
  defineContent('notFound', {
    edition: 1,
    content: {
      en: { fields: { title: 'Page not found', message: 'We could not find that page.' } },
      es: { fields: { title: 'Pagina no encontrada', message: 'No pudimos encontrar esa pagina.' } },
    },
  }),
  defineContent('nav', {
    edition: 1,
    content: {
      en: {
        fields: {
          links: [
            { link: { url: '/', text: 'Home' } },
            { link: { url: '/about', text: 'About' } },
            { link: { url: '/blog', text: 'Blog' } },
            { link: { url: '/services/web-design', text: 'Services' } },
          ],
        },
      },
      es: {
        fields: {
          links: [
            { link: { url: '/es', text: 'Inicio' } },
            { link: { url: '/es/acerca', text: 'Acerca de' } },
            { link: { url: '/blog', text: 'Blog' } },
          ],
        },
      },
    },
  }),
  defineContent('footer', {
    edition: 1,
    content: { en: { fields: { text: 'Made with Inlay.' } }, es: { fields: { text: 'Hecho con Inlay.' } } },
  }),
  defineEntries('posts', [
    {
      key: 'hello-inlay',
      edition: 1,
      content: {
        en: {
          slug: 'hello-inlay',
          fields: {
            title: 'Hello, Inlay',
            date: '2026-10-01',
            body: 'Welcome to the **example site**.\n\n## What is this?\n\nA small site built with Inlay.',
          },
        },
      },
    },
    {
      key: 'editing-content',
      edition: 1,
      content: {
        en: {
          slug: 'editing-content',
          fields: {
            title: 'Editing content',
            date: '2026-10-15',
            body: 'Editors change text and *publish* when it is ready.\n\n- Write a draft\n- Preview it\n- Publish',
          },
        },
      },
    },
    {
      key: 'tables-and-images',
      edition: 1,
      content: {
        en: {
          slug: 'tables-and-images',
          fields: { title: 'Tables and images', date: '2026-11-01', body: tablesAndImages },
        },
      },
    },
  ]),
  defineEntries('services', [
    {
      key: 'web-design',
      edition: 1,
      content: {
        en: {
          slug: 'web-design',
          fields: { title: 'Web design', summary: 'Clean, fast websites that are easy to keep up to date.' },
        },
      },
    },
  ]),
  defineEntries('testimonials', [
    {
      key: 'alex-rivera',
      edition: 1,
      content: { en: { fields: { quote: 'Updating our site is finally painless.', author: 'Alex Rivera' } } },
    },
    {
      key: 'maria-lopez',
      edition: 1,
      content: { en: { fields: { quote: 'I changed our opening hours myself in two minutes.', author: 'María López' } } },
    },
  ]),
]
