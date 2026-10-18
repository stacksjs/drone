import type { Behavior, FollowOptions } from './types'

/** The target heading, not the aircraft heading, defines 'behind'. */
export function follow(options: FollowOptions): Behavior {
  if (![options.distanceMeters, options.altitudeMeters, options.gain].every(Number.isFinite)
    || options.distanceMeters <= 0 || options.altitudeMeters <= 0 || options.gain <= 0)
    throw new RangeError('Follow settings must be finite positive numbers')
  const settings = { ...options }
  return {
    name: 'follow',
    velocity: ({ telemetry, target }) => ({
      north: (target.position.north - Math.cos(target.headingRadians) * settings.distanceMeters - telemetry.position.north) * settings.gain,
      east: (target.position.east - Math.sin(target.headingRadians) * settings.distanceMeters - telemetry.position.east) * settings.gain,
      down: (-settings.altitudeMeters - telemetry.position.down) * settings.gain,
    }),
  }
}

/** Custom behaviors return a desired velocity; the safety layer always runs next. */
export function defineBehavior(behavior: Behavior): Behavior {
  if (!behavior.name.trim() || typeof behavior.velocity !== 'function')
    throw new TypeError('A behavior needs a name and velocity function')
  return Object.freeze({ ...behavior })
}
