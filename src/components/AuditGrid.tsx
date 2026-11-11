"use client";

import { useMemo, useRef, useState } from "react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type RowClassParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Download, Search } from "lucide-react";
import type { Constraint } from "@/lib/contract";
import type { Verified } from "@/lib/store";
import { Button, VerdictBadge, type VerdictT } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 13,
  headerFontWeight: 500,
  headerFontFamily: "var(--font-mono)",
  headerFontSize: 11,
  cellHorizontalPadding: 12,
  borderRadius: 4,
  foregroundColor: "var(--color-ink)",
  headerTextColor: "var(--color-ink-2)",
  headerBackgroundColor: "var(--color-surface-2)",
  borderColor: "var(--color-line)",
  rowHoverColor: "var(--color-surface-3)",
  accentColor: "var(--color-accent)",
  wrapperBorderRadius: 6,
  wrapperBorder: { color: "var(--color-line)" },
  headerRowBorder: { color: "var(--color-ink)" },
});

type Row = {
  id: string;
  title: string;
  seller: string;
  verdict: VerdictT;
  verdictRank: number;
  price: number;
  currency: string;
  injection: string;
  issues: string;
} & Record<string, string | number>;

const RANK = { PASS: 0, FLAG: 1, BLOCK: 2 } as const;
const VERDICT_ROW_CLASS: Record<VerdictT, string> = {
  PASS: "pact-row-pass",
  FLAG: "pact-row-flag",
  BLOCK: "pact-row-block",
};

/** Every product PACT verified, as a sortable, filterable, exportable audit table. One column per requirement. */
export function AuditGrid({
  results,
  constraints,
  onSelect,
}: {
  results: Verified[];
  constraints: Constraint[];
  onSelect: (id: string) => void;
}) {
  const grid = useRef<AgGridReact<Row>>(null);
  const [filter, setFilter] = useState("");

  const rows = useMemo<Row[]>(
    () =>
      results.map((r) => {
        const bad = r.evaluation.checks.filter((c) => c.status !== "pass");
        const row: Row = {
          id: r.productId,
          title: r.record.title,
          seller: r.record.offer.domain,
          verdict: r.evaluation.verdict,
          verdictRank: RANK[r.evaluation.verdict],
          price: r.evaluation.totalCents / 100,
          currency: r.record.offer.currency,
          injection: r.injection.severity === "none" ? "Clean" : `${r.injection.severity} (${r.injection.findings.length})`,
          issues: bad.map((c) => c.label).join(", ") || "None",
        };
        for (const c of constraints) {
          const f = r.facts[c.id];
          row[`c_${c.id}`] = f ? `${f.value ?? "Yes"}${f.unit ? ` ${f.unit}` : ""}` : "Not stated";
        }
        return row;
      }),
    [results, constraints],
  );

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      {
        field: "verdict",
        headerName: "Verdict",
        width: 150,
        pinned: "left",
        sort: "asc",
        sortIndex: 0,
        comparator: (_a, _b, na, nb) => (na.data?.verdictRank ?? 0) - (nb.data?.verdictRank ?? 0),
        cellRenderer: (p: ICellRendererParams<Row>) => (p.value ? <VerdictBadge verdict={p.value} /> : null),
        filter: "agTextColumnFilter",
      },
      { field: "title", headerName: "Product", minWidth: 200, flex: 2 },
      { field: "seller", headerName: "Seller", minWidth: 130, flex: 1 },
      {
        field: "price",
        headerName: "Item price",
        width: 140,
        type: "numericColumn",
        sort: "asc",
        sortIndex: 1,
        valueFormatter: (p) =>
          p.data ? new Intl.NumberFormat("en-US", { style: "currency", currency: p.data.currency }).format(p.value) : "",
        filter: "agNumberColumnFilter",
      },
      ...constraints.map<ColDef<Row>>((c) => ({
        field: `c_${c.id}`,
        headerName: c.label,
        minWidth: 110,
        flex: 1,
        cellClass: (p) => (p.value === "Not stated" ? "text-flag" : ""),
      })),
      {
        field: "injection",
        headerName: "Injection",
        width: 110,
        cellClass: (p) => (p.value === "Clean" ? "text-muted" : "text-block font-semibold"),
      },
      { field: "issues", headerName: "Why", minWidth: 220, flex: 2, tooltipField: "issues" },
    ],
    [constraints],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search the table"
            className="input pl-9"
            aria-label="Filter audit table"
          />
        </label>
        <Button variant="secondary" onClick={() => grid.current?.api.exportDataAsCsv({ fileName: "pact-audit.csv" })}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>
      <div style={{ height: 420 }} role="region" aria-label="Audit table. Press Enter on a Match or Check first row to buy it.">
        <AgGridReact<Row>
          ref={grid}
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          getRowId={(p) => p.data.id}
          quickFilterText={filter}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          rowClassRules={{
            [VERDICT_ROW_CLASS.BLOCK]: (p: RowClassParams<Row>) => p.data?.verdict === "BLOCK",
            [VERDICT_ROW_CLASS.FLAG]: (p: RowClassParams<Row>) => p.data?.verdict === "FLAG",
            [VERDICT_ROW_CLASS.PASS]: (p: RowClassParams<Row>) => p.data?.verdict === "PASS",
          }}
          onRowClicked={(e) => e.data && e.data.verdict !== "BLOCK" && onSelect(e.data.id)}
          onCellKeyDown={(e) => {
            const key = (e.event as KeyboardEvent | null)?.key;
            if ((key === "Enter" || key === " ") && e.data && e.data.verdict !== "BLOCK") {
              e.event?.preventDefault();
              onSelect(e.data.id);
            }
          }}
          tooltipShowDelay={300}
          animateRows
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        Click a Match or Check first row, or focus it and press Enter, to buy it. Blocked rows can&apos;t be selected.
      </p>
    </div>
  );
}
