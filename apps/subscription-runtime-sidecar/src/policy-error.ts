export class RequestPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RequestPolicyError";
  }
}
