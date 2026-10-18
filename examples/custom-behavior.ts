import { defineBehavior } from '../resources/functions/drone'

/** Add your own logic here. decide() still enforces freshness and the envelope. */
export const stayNorth = defineBehavior({
  name: 'stay-north',
  velocity: ({ telemetry, target }) => ({
    north: (target.position.north + 12 - telemetry.position.north) * 0.5,
    east: (target.position.east - telemetry.position.east) * 0.5,
    down: (-12 - telemetry.position.down) * 0.5,
  }),
})
