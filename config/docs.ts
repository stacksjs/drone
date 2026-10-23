import type { BunPressOptions } from '@stacksjs/bunpress'
import { env } from '@stacksjs/env'

/** Documentation for the owned autonomy library, served by native BunPress. */

// APP_URL is often a bare host, which is not a URL on its own.
const appUrl = String(env.APP_URL || '').replace(/\/+$/, '')
const siteUrl = appUrl && !/^https?:\/\//.test(appUrl) ? `https://${appUrl}` : appUrl

const config: BunPressOptions = {
  verbose: false,
  docsDir: './docs',
  basePath: '/docs',
  outDir: './dist/docs',
  head: [['link', { rel: 'icon', href: '/docs/favicon.svg', type: 'image/svg+xml' }]],

  nav: [
    { text: 'Guide', link: '/' },
    { text: 'Runtime', link: '/runtime' },
    { text: 'Workflows', link: '/vehicles' },
    { text: 'Roadmap', link: '/roadmap/README' },
    { text: 'GitHub', link: 'https://github.com/stacksjs/drone' },
  ],

  themeConfig: {
    editLink: { pattern: 'https://github.com/stacksjs/drone/edit/main/docs/:path' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/stacksjs/drone' }],
  },

  markdown: {
    title: `${env.APP_NAME || 'Drone'} Documentation`,
    meta: {
      description: 'Owned vehicle autonomy in TypeScript: setup, runtime, simulation workflows, optional autopilot drivers and explicit validation boundaries.',
      author: env.APP_NAME || 'Drone',
    },
    syntaxHighlightTheme: 'github-dark',
    toc: {
      enabled: true,
      minDepth: 2,
      maxDepth: 3,
    },
    sidebar: {
      '/': [
        {
          text: 'Start here',
          collapsed: true,
          items: [
            { text: 'Introduction', link: '/' },
            { text: 'Architecture and failure behavior', link: '/architecture' },
            { text: 'Hardware', link: '/hardware' },
            { text: 'Raspberry Pi setup', link: '/raspberry-pi' },
            { text: 'Library API', link: '/api' },
            { text: 'Validation evidence', link: '/validation' },
            { text: 'Flight-development gates', link: '/flight-development' },
          ],
        },
        {
          text: 'Owned runtime',
          collapsed: true,
          items: [
            { text: 'Owned runtime bench foundation', link: '/runtime' },
            { text: 'Runtime bench protocol v1', link: '/runtime-protocol' },
            { text: 'Sensor bench, calibration and replay', link: '/sensors' },
            { text: 'Owned estimator', link: '/estimation' },
            { text: 'Simulated owned multirotor controls', link: '/controls' },
            { text: 'Owned authority and failsafe supervisor', link: '/authority' },
            { text: 'Owned mission engine', link: '/missions' },
            { text: 'Owned range-backed navigation', link: '/navigation' },
            { text: 'Owned runtime diagnostics, journals and replay', link: '/diagnostics' },
            { text: 'Runtime trust and image staging', link: '/runtime-updates' },
          ],
        },
        {
          text: 'Vehicles',
          collapsed: true,
          items: [
            { text: 'Owned vehicle runtime', link: '/vehicles' },
            { text: 'Owned fixed-wing profile', link: '/vehicles-air' },
            { text: 'VTOL development', link: '/vehicles-vtol' },
            { text: 'Owned ground vehicle profile', link: '/vehicles-ground' },
            { text: 'Owned surface vessel profile', link: '/vehicles-surface' },
            { text: 'Owned subsea inspection profile', link: '/vehicles-subsea' },
          ],
        },
        {
          text: 'Camera and optional drivers',
          collapsed: true,
          items: [
            { text: 'Pi AI Camera tracking', link: '/camera-tracking' },
            { text: 'Calibrated selected-target localization', link: '/vision' },
            { text: 'Owned camera and payload adapters', link: '/payloads' },
            { text: 'Replaceable autopilot drivers', link: '/drivers' },
            { text: 'Acknowledged external-driver protocols', link: '/driver-protocols' },
            { text: 'Local ArduCopter SITL integration', link: '/sitl' },
            { text: 'Selected-vehicle antenna tracking', link: '/antenna' },
          ],
        },
        {
          text: 'Survey and domain workflows',
          collapsed: true,
          items: [
            { text: 'Aerial survey collection', link: '/mapping' },
            { text: 'Known-surface stockpile volumes', link: '/volumes' },
            { text: 'Owned asset inspection', link: '/inspection' },
            { text: 'Owned agriculture sensing', link: '/agriculture' },
            { text: 'Open Farming integration', link: '/open-farming' },
            { text: 'Owned prescribed application', link: '/application' },
            { text: 'Synthetic airborne environmental sampling', link: '/environment' },
            { text: 'Simulated carried-load characterization', link: '/cargo-load' },
            { text: 'Simulated POI camera reframe', link: '/cinema' },
          ],
        },
        {
          text: 'Public safety',
          collapsed: true,
          items: [
            { text: 'Owned public-safety collection', link: '/public-safety' },
            { text: 'Authenticated incident access', link: '/public-safety-access' },
            { text: 'Incident source evidence, observations and review', link: '/public-safety-records' },
            { text: 'Private managed source datasets', link: '/public-safety-managed' },
            { text: 'Managed dataset resource qualification', link: '/public-safety-managed-budget' },
            { text: 'Incident retention enrollment and hold review', link: '/public-safety-retention' },
            { text: 'Accepted local purge', link: '/public-safety-purge' },
            { text: 'Incident coordination handover', link: '/public-safety-handover' },
            { text: 'Authorized incident workspace', link: '/public-safety-workspace' },
            { text: 'Synthetic incident execution', link: '/public-safety-execution' },
          ],
        },
        {
          text: 'Patrol',
          collapsed: true,
          items: [
            { text: 'Retained patrol contact experiment', link: '/patrol-contact' },
            { text: 'Explicit partial-charge experiment', link: '/patrol-charge' },
            { text: 'Finite patrol recurrence and explicit review', link: '/patrol-recurrence' },
            { text: 'Finite patrol simulation command', link: '/patrol-cli' },
            { text: 'Finite patrol recording and replay', link: '/patrol-recording' },
            { text: 'Authenticated patrol review ledger', link: '/patrol-review' },
          ],
        },
        {
          text: 'Roadmap and coverage',
          collapsed: true,
          items: [
            { text: 'Dependency roadmap', link: '/roadmap/README' },
            { text: 'Feature coverage', link: '/roadmap/feature-coverage' },
            { text: 'Behavior parity audit', link: '/parity' },
          ],
        },
      ],
    },
  },

  sitemap: {
    enabled: Boolean(siteUrl),
    baseUrl: siteUrl ? `${siteUrl}/docs` : '',
  },

  robots: {
    enabled: true,
  },
}

export default config
