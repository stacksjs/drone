import { patrolReviewGate } from '../resources/functions/drone/navigation/review/policy'
import { publicSafetyHandoverGate } from '../resources/functions/drone/public-safety/access/handover-policy'
import { publicSafetyRetentionGate } from '../resources/functions/drone/public-safety/retention/policy'
import { publicSafetyManagedGate } from '../resources/functions/drone/public-safety/managed/policy'
import { publicSafetyPurgeGate } from '../resources/functions/drone/public-safety/purge/policy'
import type { UserModel } from '@stacksjs/orm'
import { defineGates } from '@stacksjs/auth'
import { publicSafetyCreateGate, publicSafetyIncidentGate } from '../resources/functions/drone/public-safety/access/policy'

/**
 * Authorization Gates Configuration
 *
 * Define your application's authorization gates and policy mappings here.
 * Gates provide a simple way to authorize actions, while policies
 * organize authorization logic around particular models.
 *
 * Registered at boot by `initializeAuthorization()`, which every entry point
 * comes through - HTTP, `buddy seed`, a scheduled job, a console command.
 *
 * @see https://stacksjs.com/docs/security/authorization
 */
export default defineGates({
  /**
   * Gate definitions
   *
   * Simple ability checks that don't require a model. The names below are what
   * `Gate.allows('...')` offers as completions.
   *
   * @example
   * import { Gate } from '@stacksjs/auth'
   *
   * if (await Gate.allows('edit-settings', user)) {
   *   // User can edit settings
   * }
   */
  gates: {
    'patrol:create': user => patrolReviewGate(user, 'create'),
    'patrol:read': user => patrolReviewGate(user, 'read'),
    'patrol:review': user => patrolReviewGate(user, 'review'),
    'patrol:approve': user => patrolReviewGate(user, 'approve'),
    'patrol:consume': user => patrolReviewGate(user, 'consume'),
    'public-safety:workspace-read': (user, key: string) => publicSafetyIncidentGate(user, key, 'view'),
    'public-safety:handover-read': (user, key: string) => publicSafetyHandoverGate(user, key, 'read'),
    'public-safety:handover-write': (user, key: string) => publicSafetyHandoverGate(user, key, 'write'),
    'public-safety:purge-preview': (user, key: string) => publicSafetyPurgeGate(user, key, 'preview'),
    'public-safety:purge-accept': (user, key: string) => publicSafetyPurgeGate(user, key, 'accept'),
    'public-safety:purge-read': (user, key: string) => publicSafetyPurgeGate(user, key, 'read'),
    'public-safety:purge-events': (user, key: string) => publicSafetyPurgeGate(user, key, 'events'),
    'public-safety:purge-retry': (user, key: string) => publicSafetyPurgeGate(user, key, 'retry'),
    'public-safety:managed-read': (user, key: string) => publicSafetyManagedGate(user, key, 'read'),
    'public-safety:managed-create': (user, key: string) => publicSafetyManagedGate(user, key, 'create'),
    'public-safety:managed-events': (user, key: string) => publicSafetyManagedGate(user, key, 'events'),
    'public-safety:managed-reconcile': (user, key: string) => publicSafetyManagedGate(user, key, 'reconcile'),
    'public-safety:retention-read': (user, key: string) => publicSafetyRetentionGate(user, key, 'read'),
    'public-safety:retention-manage': (user, key: string) => publicSafetyRetentionGate(user, key, 'manage'),
    'public-safety:retention-revoke': (user, key: string) => publicSafetyRetentionGate(user, key, 'revoke'),
    'public-safety:create': publicSafetyCreateGate,
    'public-safety:view': (user, key: string) => publicSafetyIncidentGate(user, key, 'view'),
    'public-safety:audit': (user, key: string) => publicSafetyIncidentGate(user, key, 'audit'),
    'public-safety:manage-members': (user, key: string) => publicSafetyIncidentGate(user, key, 'manage-members'),
    'public-safety:close': (user, key: string) => publicSafetyIncidentGate(user, key, 'close'),
    'public-safety:source-register': (user, key: string) => publicSafetyIncidentGate(user, key, 'source-register'),
    'public-safety:observation-create': (user, key: string) => publicSafetyIncidentGate(user, key, 'observation-create'),
    'public-safety:review-append': (user, key: string) => publicSafetyIncidentGate(user, key, 'review-append'),
    /** Check if user can access admin area */
    'access-admin': (user: UserModel | null) => {
      return user?.email?.endsWith('@stacksjs.com') ?? false
    },

    /** Check if user can edit application settings */
    'edit-settings': (user: UserModel | null) => {
      // Add your logic here
      return user !== null
    },

    /** Check if user can view dashboard */
    'view-dashboard': (user: UserModel | null) => {
      return user !== null
    },

    /**
     * Whether a user may run a configured operation on a configured host
     * (stacksjs/stacks#960).
     *
     * Receives the host key and the command key, so scope by either or both.
     * Declaring a host in `config/remote.ts` does NOT grant anyone access to
     * it - without this gate defined, every run is refused, which is the
     * correct default for a surface that runs commands on a server.
     *
     * @example Only the on-call team, and only on the app box
     * 'run-remote-command': (user, hostKey) =>
     *   hostKey === 'app' && user?.email?.endsWith('@example.com') === true,
     */
    // 'run-remote-command': (user: UserModel | null, hostKey: string, commandKey: string) => false,

    /**
     * Whether a user may open an interactive terminal on a configured host
     * (stacksjs/stacks#960).
     *
     * A terminal is every command at once, so this is its own ability, and
     * the host must also allow it with `terminal: true` in `config/remote.ts`.
     * Without this gate defined, every session is refused.
     *
     * @example Only admins, and only on the app box
     * 'open-remote-terminal': (user, hostKey) =>
     *   hostKey === 'app' && user?.email?.endsWith('@example.com') === true,
     */
    // 'open-remote-terminal': (user: UserModel | null, hostKey: string) => false,

    // Add more gates here...
    // 'ability-name': (user, ...args) => boolean,
  },

  /**
   * Policy mappings
   *
   * Map model names to their policy classes. Policy files live in
   * `app/Policies/`, or in the framework defaults behind it. Both halves are
   * checked: the key names a model that exists, the value a policy that does.
   *
   * A policy whose file is named `<Model>Policy.ts` is picked up by convention
   * and does not need an entry here. An entry WINS over the convention, which
   * is the point of writing one.
   *
   * @example
   * // Simple mapping (uses PostPolicy for the Post model)
   * Post: 'PostPolicy',
   *
   * // Or with config:
   * Post: {
   *   policy: 'PostPolicy',
   *   model: 'Post',
   * },
   */
  policies: {
    // Post: 'PostPolicy',
    // User: 'UserPolicy',
    // Comment: 'CommentPolicy',
  },

  /**
   * Before callbacks
   *
   * Run before any gate/policy check. Return true to allow,
   * false to deny, or null to continue to the actual check.
   */
  before: [
    // Example: Super admin bypass
    // (user) => {
    //   if (user?.role === 'super-admin')
    //     return true // Allow everything for super admins
    //   return null // Continue to normal checks
    // },
  ],

  /**
   * After callbacks
   *
   * Run after gate/policy checks. Returning a boolean overrides the result;
   * returning nothing keeps it.
   */
  after: [
    // Example: Log all authorization checks
    // (user, ability, result) => {
    //   console.log(`User ${user?.id} ${result ? 'allowed' : 'denied'} for ${ability}`)
    // },
  ],
})
