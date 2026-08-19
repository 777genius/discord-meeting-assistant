export class PostgresSchemaReadinessError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresSchemaReadinessError";
  }
}
