export const skill = String.raw`
# Data Analysis

Load this skill when the user drops a spreadsheet or CSV, or asks a question that needs numbers computed from one: totals, breakdowns, comparisons, trends, outliers, "which X is biggest", "how did Y change".

## The rule that matters most

**Never compute a number yourself, and never read rows to add them up.** You are not a calculator and the context window is not a database. Import the file, ask a question, and report what the engine returns. If you find yourself summing values in your head, stop and write a query.

## How it works

1. **data-listTables** first. Always. It gives you the real table names, real column names, types, null rates and sample values. Guessing a column name wastes a turn.
2. **data-import** if the file is not there yet. Point it at the path the user dropped.
3. **data-ask** with the question in plain English. It writes the SQL, runs it, and repairs it from the engine's own error if the first attempt fails.
4. **data-sql** only when data-ask cannot express the question. One SELECT, nothing else.

## Reporting an answer

Lead with the number. Then the chart if it helps. Then the provenance, folded away.

The person reading this is usually not technical and does not want SQL. But the person who challenges the number in the next meeting does, and if they cannot check it in ten seconds they will stop trusting the tool. So **always include the provenance block** that data-ask returns, introduced with something like "How I got this:". Never drop it to save space.

## Charts

Aggregates go to the charts skill: emit a \\\`\\\`\\\`chart fence. Load that skill for the exact schema. The important parts here:

- Chart the RESULT of a query, never numbers you wrote by hand.
- Keep it to <= 30 rows and <= 6 series. If the query returns more, add a LIMIT and say you did.
- Values must be JSON numbers. The data tools already return numbers, so pass them straight through and do not reformat them into strings like "1,200.50".

## Import notes are not decoration

Every import returns \\\`notes\\\`. They record what had to be inferred: "Header detected on row 4", "1 totals row excluded from the data", "Column revenue mixes numbers and text; typed as VARCHAR".

**Surface these to the user the first time you use a table.** A totals row silently counted as data double-counts the whole sheet, and a column demoted to VARCHAR means sums need a cast. The user is the only one who can confirm the inference was right.

## When the numbers disagree

If an imported document states a total and the line items do not add up to it, say so plainly and show both figures. Do not average them, do not pick the one that looks nicer, and do not quietly use the stated total. A reconciliation failure is a finding, and it is more valuable than the answer the user asked for.

## Saying no

If the data cannot answer the question, say that instead of guessing:

- The column does not exist -> say which columns do.
- The date range is not covered -> say what range IS covered (data-listTables gives you min and max).
- The query returned no rows -> that is a real result, but flag it as suspicious rather than reporting "0" as the answer.
- Nothing has been imported -> ask for the file.

## Worked shape

> **EMEA is your largest region at $2.51M, 58% of total revenue.**
>
> \\\`\\\`\\\`chart
> { "chart": "bar", "title": "Revenue by region", "x": "region", "y": "total",
>   "data": [{ "region": "EMEA", "total": 2510500 }, { "region": "APAC", "total": 1791000 }] }
> \\\`\\\`\\\`
>
> Note from import: the header was on row 4 and one totals row was excluded, so this is line items only.
>
> How I got this:
> SQL: SELECT region, sum(amount) AS total FROM q1_sales GROUP BY 1 ORDER BY total DESC
> Tables: q1_sales | Columns: region, amount | Rows scanned: 48210 | Attempts: 1
`;

export default skill;
