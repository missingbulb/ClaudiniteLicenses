// Reads the security review's route table out of docs/license-record.md, so the tests that hold the
// table to the code, and the per-Worker tests that loop over its rows, read one list.

export const ROUTE_TABLE_HEADING = "### The routes";

/**
 * @typedef {{ method: string, path: string, worker: string, reached: string, caller: string, auth: string, touches: string, cap: string, test: string }} RouteRow
 */

/** @param {string} cell */
const unquote = (cell) => cell.trim().replace(/^`|`$/g, "");

/**
 * The rows of the table under ROUTE_TABLE_HEADING, in order.
 * @param {string} markdown @returns {RouteRow[]}
 */
export function routeTable(markdown) {
  const start = markdown.indexOf(`\n${ROUTE_TABLE_HEADING}\n`);
  if (start < 0) throw new Error(`no "${ROUTE_TABLE_HEADING}" section`);
  const lines = markdown.slice(start).split("\n").slice(2);
  /** @type {RouteRow[]} */
  const rows = [];
  let inTable = false;
  for (const line of lines) {
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.split("|").slice(1, -1);
    if (cells[0]?.trim() === "Route" || /^\s*-+\s*$/.test(cells[0] ?? "")) continue;
    const [route, worker, reached, caller, auth, touches, cap, test] = cells.map((c) => c.trim());
    const m = /^`([A-Z]+) (\/\S*)`$/.exec(route ?? "");
    if (!m) throw new Error(`route table: ${JSON.stringify(route)} is not \`METHOD /path\``);
    rows.push({ method: m[1], path: m[2], worker: unquote(worker ?? ""), reached: reached ?? "", caller: caller ?? "", auth: auth ?? "", touches: touches ?? "", cap: cap ?? "", test: test ?? "" });
  }
  return rows;
}

/** Whether a row's cap is the per-address cap, in front of every request or only on a refusal. @param {RouteRow} row */
export function perAddressCap(row) {
  return /^per-address\b/.test(row.cap);
}
