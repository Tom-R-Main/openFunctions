/**
 * Expense Splitter — Example Tool Domain
 *
 * A shared-expense tracker that calculates who owes whom.
 * Uses in-memory storage (no database needed).
 *
 * This demonstrates math/calculations and settlement algorithms:
 *   1. Recording shared expenses with flexible splits
 *   2. Computing per-person net balances (paid vs. owed)
 *   3. Greedy settlement — minimizing transactions by matching
 *      the largest creditor with the largest debtor repeatedly
 *
 * In a real app, you'd replace the in-memory Map with a database.
 */

import { defineTool, ok, err, createStore } from "../../framework/index.js";

// ─── Data ──────────────────────────────────────────────────────────────────

interface Expense {
  id: string;
  description: string;
  amount: number;
  paidBy: string;
  splitBetween: string[];
  createdAt: string;
}

/** Parameter types — match these to your inputSchema */
interface AddExpenseParams {
  description: string;
  amount: number;
  paid_by: string;
  split_between: string[];
}

// split_bill and get_balances take no required params
interface SplitBillParams {}
interface GetBalancesParams {}

/** Persistent store — data saved to .data/expenses.json, survives restarts */
const expenses = createStore<Expense>("expenses");
let nextId = expenses.size + 1;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a map of person -> net balance across all expenses.
 * Positive balance = the person is owed money (creditor).
 * Negative balance = the person owes money (debtor).
 */
function computeNetBalances(): Map<string, { totalPaid: number; totalOwed: number; net: number }> {
  const balances = new Map<string, { totalPaid: number; totalOwed: number; net: number }>();

  // Ensure a person entry exists
  const ensure = (name: string) => {
    if (!balances.has(name)) {
      balances.set(name, { totalPaid: 0, totalOwed: 0, net: 0 });
    }
  };

  for (const expense of expenses.getAll()) {
    const share = expense.amount / expense.splitBetween.length;

    // The payer paid the full amount
    ensure(expense.paidBy);
    balances.get(expense.paidBy)!.totalPaid += expense.amount;

    // Each person in the split owes their share
    for (const person of expense.splitBetween) {
      ensure(person);
      balances.get(person)!.totalOwed += share;
    }
  }

  // Compute net = totalPaid - totalOwed for each person
  for (const [, entry] of balances) {
    entry.net = entry.totalPaid - entry.totalOwed;
  }

  return balances;
}

// ─── Tools ─────────────────────────────────────────────────────────────────

export const addExpense = defineTool<AddExpenseParams>({
  name: "add_expense",
  description:
    "Record a shared expense. Use this when someone pays for something " +
    "that should be split among a group of people.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "What the expense was for (e.g. 'Dinner at Mario's')",
      },
      amount: {
        type: "number",
        description: "Total amount paid in dollars (e.g. 60.00)",
      },
      paid_by: {
        type: "string",
        description: "Name of the person who paid (e.g. 'Alice')",
      },
      split_between: {
        type: "array",
        items: { type: "string" },
        description:
          "Names of everyone sharing this expense, including the payer (e.g. ['Alice', 'Bob', 'Carol'])",
      },
    },
    required: ["description", "amount", "paid_by", "split_between"],
  },
  tags: ["finance", "expense-splitting"],
  examples: [
    {
      description: "Record a dinner split three ways",
      input: {
        description: "Dinner at Mario's",
        amount: 60,
        paid_by: "Alice",
        split_between: ["Alice", "Bob", "Carol"],
      },
      output: {
        success: true,
        data: {
          id: "1",
          description: "Dinner at Mario's",
          amount: 60,
          paidBy: "Alice",
          splitBetween: ["Alice", "Bob", "Carol"],
        },
      },
    },
  ],
  handler: async ({ description, amount, paid_by, split_between }) => {
    // Validate inputs
    if (amount <= 0) {
      return err("Amount must be greater than zero");
    }
    if (split_between.length === 0) {
      return err("split_between must include at least one person");
    }

    const id = String(nextId++);
    const expense: Expense = {
      id,
      description,
      amount,
      paidBy: paid_by,
      splitBetween: split_between,
      createdAt: new Date().toISOString(),
    };
    expenses.set(id, expense);

    return ok(
      expense,
      `Recorded $${amount.toFixed(2)} paid by ${paid_by}, split between ${split_between.join(", ")}`,
    );
  },
});

export const splitBill = defineTool<SplitBillParams>({
  name: "split_bill",
  description:
    "Calculate settlements — who owes whom and how much. " +
    "Uses a greedy algorithm to minimize the number of transactions. " +
    "Call this after adding expenses to see how to settle up.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  tags: ["finance", "expense-splitting"],
  examples: [
    {
      description: "Calculate settlements after recording expenses",
      input: {},
      output: {
        success: true,
        data: {
          settlements: [{ from: "Bob", to: "Alice", amount: 20 }],
        },
      },
    },
  ],
  handler: async () => {
    const allExpenses = expenses.getAll();
    if (allExpenses.length === 0) {
      return err("No expenses recorded yet. Add some expenses first.");
    }

    const balances = computeNetBalances();

    // Separate people into creditors (positive net) and debtors (negative net)
    // Creditors are owed money; debtors owe money.
    const creditors: { person: string; amount: number }[] = [];
    const debtors: { person: string; amount: number }[] = [];

    for (const [person, entry] of balances) {
      if (entry.net > 0.01) {
        creditors.push({ person, amount: entry.net });
      } else if (entry.net < -0.01) {
        debtors.push({ person, amount: -entry.net }); // store as positive for easier math
      }
    }

    // Greedy settlement: sort both lists descending, then match largest with largest
    creditors.sort((a, b) => b.amount - a.amount);
    debtors.sort((a, b) => b.amount - a.amount);

    const settlements: { from: string; to: string; amount: number }[] = [];
    let ci = 0;
    let di = 0;

    while (ci < creditors.length && di < debtors.length) {
      const transfer = Math.min(creditors[ci].amount, debtors[di].amount);

      // Round to 2 decimal places to avoid floating-point dust
      const rounded = Math.round(transfer * 100) / 100;
      if (rounded > 0) {
        settlements.push({
          from: debtors[di].person,
          to: creditors[ci].person,
          amount: rounded,
        });
      }

      creditors[ci].amount -= transfer;
      debtors[di].amount -= transfer;

      // Move past anyone whose balance is now settled
      if (creditors[ci].amount < 0.01) ci++;
      if (debtors[di].amount < 0.01) di++;
    }

    return ok(
      { settlements, expenseCount: allExpenses.length },
      settlements.length === 0
        ? "Everyone is settled up!"
        : `${settlements.length} settlement${settlements.length === 1 ? "" : "s"} needed`,
    );
  },
});

export const getBalances = defineTool<GetBalancesParams>({
  name: "get_balances",
  description:
    "Get a per-person summary of all expenses: total paid, total owed, and net balance. " +
    "Use this to see an overview before settling up.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  tags: ["finance", "expense-splitting"],
  handler: async () => {
    const allExpenses = expenses.getAll();
    if (allExpenses.length === 0) {
      return err("No expenses recorded yet. Add some expenses first.");
    }

    const balances = computeNetBalances();

    // Convert to a sorted array for consistent output
    const summary = Array.from(balances.entries())
      .map(([person, entry]) => ({
        person,
        totalPaid: Math.round(entry.totalPaid * 100) / 100,
        totalOwed: Math.round(entry.totalOwed * 100) / 100,
        net: Math.round(entry.net * 100) / 100,
      }))
      .sort((a, b) => b.net - a.net); // creditors first

    return ok(
      { balances: summary, expenseCount: allExpenses.length },
      `Balances for ${summary.length} ${summary.length === 1 ? "person" : "people"} across ${allExpenses.length} expense${allExpenses.length === 1 ? "" : "s"}`,
    );
  },
});

/** All expense splitter tools — register these with the registry */
export const expenseSplitterTools = [addExpense, splitBill, getBalances];
