export class FusionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionConfigError";
  }
}

export class FusionArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionArgsError";
  }
}
