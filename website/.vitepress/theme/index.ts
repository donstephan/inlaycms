import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import HomeClosing from './HomeClosing.vue'
import HomeCode from './HomeCode.vue'
import HomeInstall from './HomeInstall.vue'
import HomeSteps from './HomeSteps.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-actions-after': () => h(HomeInstall),
      'home-hero-image': () => h(HomeCode),
      'home-features-before': () => h(HomeSteps),
      'home-features-after': () => h(HomeClosing),
    }),
} satisfies Theme
