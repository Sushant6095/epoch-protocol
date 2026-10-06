"use client";
// Every table on the three pages: TanStack Table v9 (sorting) rendered with the shadcn table. Numbers are mono and
// right-aligned (`meta.numeric`), headers are real <th scope="col"> with sort buttons, rows are 44 px (dense data
// console), and the caller marks highlighted rows (the leader that sets the index, the buyback escrow's trades).

import {
  type ColumnDef,
  createColumnHelper,
  createSortedRowModel,
  type RowData,
  rowSortingFeature,
  sortFn_alphanumeric,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const tableFeaturesSorted = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
type Features = typeof tableFeaturesSorted;

export const columnHelper = <T extends RowData>() => createColumnHelper<Features, T>();
export type Column<T extends RowData> = ColumnDef<Features, T, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ColumnMeta {
  numeric?: boolean;
  className?: string;
}

export function DataTable<T extends RowData>({
  columns,
  data,
  getRowId,
  initialSorting = [],
  rowClassName,
  caption,
  emptyText = "Nothing here yet.",
  className,
}: {
  columns: Column<T>[];
  data: T[];
  getRowId?: (row: T, index: number) => string;
  initialSorting?: SortingState;
  rowClassName?: (row: T) => string | undefined;
  caption?: ReactNode;
  emptyText?: string;
  className?: string;
}) {
  const table = useTable({
    features: tableFeaturesSorted,
    columns,
    data,
    getRowId: getRowId ? (row: T, index: number) => getRowId(row, index) : undefined,
    initialState: { sorting: initialSorting },
  });
  return (
    <div className={cn("overflow-x-auto", className)}>
      <Table className="min-w-max">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="border-ep-line hover:bg-transparent">
              {group.headers.map((header) => {
                const meta = (header.column.columnDef.meta ?? {}) as ColumnMeta;
                const sorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                return (
                  <TableHead
                    key={header.id}
                    scope="col"
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                    className={cn("label-caps h-10 whitespace-nowrap", meta.numeric && "text-right", meta.className)}
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "inline-flex min-h-8 items-center gap-1 rounded-sm uppercase tracking-wider transition-colors duration-200 hover:text-ep-text",
                          meta.numeric && "flex-row-reverse",
                        )}
                      >
                        <table.FlexRender header={header} />
                        {sorted === "asc" ? (
                          <ArrowUp className="size-3" aria-hidden />
                        ) : sorted === "desc" ? (
                          <ArrowDown className="size-3" aria-hidden />
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" aria-hidden />
                        )}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="h-20 text-center text-sm text-ep-muted">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className={cn("h-11 border-ep-line hover:bg-ep-hover", rowClassName?.(row.original))}>
                {row.getAllCells().map((cell) => {
                  const meta = (cell.column.columnDef.meta ?? {}) as ColumnMeta;
                  return (
                    <TableCell key={cell.id} className={cn("text-sm", meta.numeric && "num text-right", meta.className)}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
