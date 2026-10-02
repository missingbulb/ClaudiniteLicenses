export declare const ROUTE_TABLE_HEADING: string;
export interface RouteRow {
  method: string;
  path: string;
  worker: string;
  reached: string;
  caller: string;
  auth: string;
  touches: string;
  cap: string;
  test: string;
}
export declare function routeTable(markdown: string): RouteRow[];
export declare function perAddressCap(row: RouteRow): boolean;
