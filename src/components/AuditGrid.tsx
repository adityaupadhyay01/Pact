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
import { getListing } from "@/lib/marketplace";
import type { ListingResult } from "@/lib/store";
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

interface Row {
  id: string;
  title: string;
  seller: string;
  verdict: VerdictT;
  verdictRank: number;
  total: number;
  currency: string;
  listed: number;
  ram: number | null;
  storage: number | null;
  warranty: number | null;
  condition: string | null;
  issues: string;
  blocks: number;
  flags: number;
  injection: string;
}

const RANK = { PASS: 0, FLAG: 1, BLOCK: 2 } as const;
const VERDICT_ROW_CLASS: Record<VerdictT, string> = {
  PASS: "pact-row-pass",
  FLAG: "pact-row-flag",
  BLOCK: "pact-row-block",
};

const missing = (v: unknown) => (v === null || v === undefined ? "Not stated" : null);

/** Every listing PACT evaluated, as a sortable, filterable, exportable audit table. */
export function AuditGrid({ results, onSelect }: { results: ListingResult[]; onSelect: (id: string) => void }) {
  const grid = useRef<AgGridReact<Row>>(null);
  const [filter, setFilter] = useState("");

  const rows = useMemo<Row[]>(
    () =>
      results.map((r) => {
        const l = getListing(r.listingId)!;
        const bad = r.evaluation.checks.filter((c) => c.status !== "pass");
        return {
          id: r.listingId,
          title: l.title,
          seller: l.seller,
          verdict: r.evaluation.verdict,
          verdictRank: RANK[r.evaluation.verdict],
          total: r.evaluation.totalCents / 100,
          currency: l.checkout.currency,
          listed: l.listedPrice,
          ram: r.facts.ramGb?.value ?? null,
          storage: r.facts.storageGb?.value ?? null,
          warranty: r.facts.warrantyMonths?.value ?? null,
          condition: r.facts.condition?.value ?? null,
          issues: bad.map((c) => c.label).join(", ") || "—",
          blocks: bad.filter((c) => c.status === "block").length,
          flags: bad.filter((c) => c.status === "flag").length,
          injection: r.injection.severity === "none" ? "Clean" : `${r.injection.severity} (${r.injection.findings.length})`,
        };
      }),
    [results],
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
      { field: "title", headerName: "Listing", minWidth: 200, flex: 2 },
      { field: "seller", headerName: "Seller", minWidth: 130, flex: 1 },
      {
        field: "total",
        headerName: "All-in total",
        width: 165,
        type: "numericColumn",
        sort: "asc",
        sortIndex: 1,
        valueFormatter: (p) =>
          p.data ? new Intl.NumberFormat("en-US", { style: "currency", currency: p.data.currency }).format(p.value) : "",
        filter: "agNumberColumnFilter",
      },
      {
        field: "listed",
        headerName: "Listed",
        width: 95,
        type: "numericColumn",
        valueFormatter: (p) => (p.data ? `${p.data.currency === "USD" ? "$" : p.data.currency + " "}${p.value}` : ""),
        filter: "agNumberColumnFilter",
      },
      {
        field: "ram",
        headerName: "RAM",
        width: 85,
        valueFormatter: (p) => missing(p.value) ?? `${p.value}GB`,
        filter: "agNumberColumnFilter",
      },
      {
        field: "storage",
        headerName: "Storage",
        width: 95,
        valueFormatter: (p) => missing(p.value) ?? (p.value >= 1000 ? `${p.value / 1000}TB` : `${p.value}GB`),
        filter: "agNumberColumnFilter",
      },
      {
        field: "warranty",
        headerName: "Warranty",
        width: 105,
        valueFormatter: (p) => missing(p.value) ?? `${p.value} mo`,
        cellClass: (p) => (p.value === null ? "text-flag" : ""),
        filter: "agNumberColumnFilter",
      },
      {
        field: "condition",
        headerName: "Condition",
        width: 115,
        valueFormatter: (p) => missing(p.value) ?? String(p.value),
        cellClass: (p) => (p.value && p.value !== "new" ? "text-block font-medium" : ""),
      },
      {
        field: "injection",
        headerName: "Injection",
        width: 110,
        cellClass: (p) => (p.value === "Clean" ? "text-muted" : "text-block font-semibold"),
      },
      { field: "issues", headerName: "Why", minWidth: 220, flex: 2, tooltipField: "issues" },
    ],
    [],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search, e.g. refurbished or warranty"
            className="input pl-9"
            aria-label="Filter audit table"
          />
        </label>
        <Button
          variant="secondary"
          onClick={() => grid.current?.api.exportDataAsCsv({ fileName: "pact-listing-audit.csv" })}
        >
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>
      <div style={{ height: 580 }} role="region" aria-label="Listing audit table. Press Enter on a PASS or FLAG row to buy it.">
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
        Click a PASS or FLAG row, or focus it and press Enter, to buy it. BLOCK rows can&apos;t be selected. Sort, filter or export the audit for a
        record.
      </p>
    </div>
  );
}
