/** An error with an HTTP status and a machine-readable code. Its message is safe to show to the buyer. */
export class PactError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
