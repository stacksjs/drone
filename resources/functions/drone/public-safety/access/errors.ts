/** Deliberately bounded public errors; callers never receive SQL, credentials or stored incident content. */
export class PublicSafetyAccessError extends Error {
  constructor(public readonly status: 401 | 403 | 404 | 409 | 422, message: string) {
    super(message)
    this.name = 'PublicSafetyAccessError'
  }
}
