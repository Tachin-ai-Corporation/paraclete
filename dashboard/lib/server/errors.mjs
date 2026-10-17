// dashboard/lib/server/errors.mjs: the one error type server code throws on purpose. route() in
// http.mjs answers it with its status and message; anything else thrown is a 500.

/** An error the person asking should see, with its HTTP status. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message shown to the person asking
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
