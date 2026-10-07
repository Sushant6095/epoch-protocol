/** The kit's one error class: a stable code for scripts and tests, and a message that says what to do. */
export type KitErrorCode =
  | 'BAD_ARGS'
  | 'BAD_URL'
  | 'MAINNET_REFUSED'
  | 'GENESIS_MISMATCH'
  | 'KEY_IN_REPO'
  | 'KEY_MISSING'
  | 'STATE_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'NOT_DEPLOYED'
  | 'NOT_INITIALIZED'
  | 'COMMAND_FAILED'
  | 'CHECK_FAILED'
  | 'TX_FAILED';

export class KitError extends Error {
  constructor(
    readonly code: KitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KitError';
  }
}
