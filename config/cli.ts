import type { BinaryConfig } from '@stacksjs/types'

/**
 * **Binary / CLI Configuration**
 *
 * This configuration defines all of your Binary/CLI options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  name: 'Drone',
  command: 'drone',
  description: 'Owned vehicle runtime development and bench tools',
  deploy: false,
} satisfies BinaryConfig
