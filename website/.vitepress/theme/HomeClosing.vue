<script setup lang="ts">
import { withBase } from 'vitepress'
</script>

<template>
  <section class="home-closing">
    <div class="home-wrap">
      <h2>Ten minutes to a running site</h2>
      <p class="home-sub">Install, define one page, run <code>inlaycms dev</code>.</p>
      <a class="home-closing-button" :href="withBase('/docs/quickstart')">Start the quickstart</a>
    </div>
  </section>
</template>
