// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The BeeSlides authors
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

// GitHub Pages serves the project site under /beeSlides/: the repo's name,
// and Pages paths are case-sensitive. Override with SITE_BASE=/ for a custom
// domain or a local preview at the root.
const base = process.env.SITE_BASE ?? '/beeSlides'

export default defineConfig({
  site: 'https://miqsoft.github.io',
  base,
  integrations: [
    starlight({
      title: 'BeeSlides',
      description: 'Slides that fit in a file — a PowerPoint alternative that is a single HTML file.',
      logo: { src: './src/logo.svg' },
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/miqsoft/beeslides' },
      ],
      editLink: { baseUrl: 'https://github.com/miqsoft/beeslides/edit/main/site/' },
      customCss: ['./src/styles/theme.css'],
      lastUpdated: true,
      sidebar: [
        { label: 'Get started', items: [{ autogenerate: { directory: 'start' } }] },
        { label: 'Create', items: [{ autogenerate: { directory: 'create' } }] },
        { label: 'Present', items: [{ autogenerate: { directory: 'present' } }] },
        { label: 'Share', items: [{ autogenerate: { directory: 'share' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Contribute', items: [{ autogenerate: { directory: 'contribute' } }] },
      ],
    }),
  ],
})
