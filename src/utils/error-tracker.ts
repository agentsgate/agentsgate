import { randomUUID } from 'node:crypto';

export interface ErrorEntry {
  id: string;
  timestamp: Date;
  module: string;
  message: string;
  stack?: string;
  operationId?: string;
  context?: Record<string, unknown>;
}

export class ErrorTracker {
  private readonly buffer: ErrorEntry[] = [];
  private readonly maxSize: number;
  private readonly debug: boolean;

  constructor(options: { maxSize?: number; debug?: boolean } = {}) {
    this.maxSize = options.maxSize ?? 200;
    this.debug = options.debug ?? (process.env['AGENTSGATE_DEBUG'] === '1');
  }

  track(
    module: string,
    error: unknown,
    options: { operationId?: string; context?: Record<string, unknown> } = {}
  ): ErrorEntry {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    const entry: ErrorEntry = {
      id: randomUUID(),
      timestamp: new Date(),
      module,
      message,
      stack,
      operationId: options.operationId,
      context: options.context,
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    if (this.debug) {
      const lines: string[] = [
        `[AgentsGate] ERROR [${module}] ${message}`,
      ];
      if (stack) lines.push(stack);
      if (options.operationId) lines.push(`  operationId: ${options.operationId}`);
      if (options.context) lines.push(`  context: ${JSON.stringify(options.context)}`);
      process.stderr.write(lines.join('\n') + '\n');
    }

    return entry;
  }

  list(limit = 50): ErrorEntry[] {
    return [...this.buffer].reverse().slice(0, limit);
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
