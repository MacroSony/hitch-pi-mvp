export class AsyncSemaphore {
  readonly #limit: number;
  #available: number;
  #waiting: Array<() => void> = [];

  public constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("semaphore limit must be a positive safe integer");
    this.#limit = limit;
    this.#available = limit;
  }

  public get limit(): number {
    return this.#limit;
  }

  public get available(): number {
    return this.#available;
  }

  public get waiting(): number {
    return this.#waiting.length;
  }

  public async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
    return () => this.release();
  }

  public release(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    if (this.#available < this.#limit) this.#available += 1;
  }
}
