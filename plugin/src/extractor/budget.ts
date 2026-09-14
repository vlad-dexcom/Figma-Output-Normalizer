// Hard cap on total nodes visited per export, plus cooperative yielding so a
// large screen doesn't hang the plugin sandbox's single JS thread. See
// concern #9 in the plugin-extractor task description.

/** Thrown when a single extraction visits more nodes than the budget allows. */
export class NodeBudgetExceededError extends Error {
  constructor(public readonly limit: number) {
    super(
      `Figma Normalizator: this selection has more than ${limit} nodes. ` +
        `Extraction was stopped rather than silently truncating the output — ` +
        `select a smaller region, or split the export into multiple smaller selections.`,
    );
    this.name = "NodeBudgetExceededError";
  }
}

export const DEFAULT_NODE_BUDGET = 5000;

/** How many nodes to visit between cooperative yields back to the event loop. */
const YIELD_EVERY = 200;

export class NodeBudget {
  private visited = 0;

  constructor(private readonly limit: number = DEFAULT_NODE_BUDGET) {}

  /** Call once per node visited. Throws if the budget is exceeded. */
  async tick(): Promise<void> {
    this.visited += 1;
    if (this.visited > this.limit) {
      throw new NodeBudgetExceededError(this.limit);
    }
    if (this.visited % YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  get count(): number {
    return this.visited;
  }
}

/**
 * Thrown when a token export visits more variables than the budget allows.
 *
 * Deliberately a different type and a different message from
 * `NodeBudgetExceededError`: that one tells you to "select a smaller
 * region", advice which is meaningless for a file-scoped token export —
 * there is no sub-selection of a variable collection. The actionable advice
 * here is to exclude collections via the policy instead.
 */
export class VariableBudgetExceededError extends Error {
  constructor(public readonly limit: number) {
    super(
      `Figma Normalizator: this file has more than ${limit} design-token variables. ` +
        `Extraction was stopped rather than silently truncating the output — ` +
        `exclude collections you don't need in mappings/collections-policy.yaml, ` +
        `or raise the budget.`,
    );
    this.name = "VariableBudgetExceededError";
  }
}

/**
 * Default cap for a token export. Sized against real data: a production file
 * carried 2200 variables across 41 collections (2000 of them local), so
 * 10000 leaves generous headroom while still catching a runaway walk.
 */
export const DEFAULT_VARIABLE_BUDGET = 10000;

/**
 * Same cooperative-yield mechanic as `NodeBudget`, metered in variables.
 *
 * A token export resolves alias chains across thousands of variables on the
 * sandbox's single JS thread, so yielding matters at least as much here as
 * it does for node extraction.
 */
export class VariableBudget {
  private visited = 0;

  constructor(private readonly limit: number = DEFAULT_VARIABLE_BUDGET) {}

  async tick(): Promise<void> {
    this.visited += 1;
    if (this.visited > this.limit) {
      throw new VariableBudgetExceededError(this.limit);
    }
    if (this.visited % YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  get count(): number {
    return this.visited;
  }
}
