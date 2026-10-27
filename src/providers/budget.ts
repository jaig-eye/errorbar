import { BudgetExceededError } from '../errors';

/** Counts provider calls across a whole run and stops it at `max_calls`. */
export class CallBudget {
  used = 0;
  exceeded = false;

  constructor(readonly max?: number) {}

  take(): void {
    if (this.max !== undefined && this.used >= this.max) {
      this.exceeded = true;
      throw new BudgetExceededError(this.max);
    }
    this.used++;
  }
}
