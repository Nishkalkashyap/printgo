export class PrintGoError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PrintGoError';
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
