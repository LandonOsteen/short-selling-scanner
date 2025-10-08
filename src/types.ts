export type PatternType = 'HODBreakCloseUnder' | 'ToppingTail1m' | 'ToppingTail5m' | 'GreenRunReject' | 'TestSignal';

export interface Alert {
  id: string;
  timestamp: number;
  symbol: string;
  type: PatternType;
  detail: string;
  price: number;
  volume: number;
  gapPercent?: number;
  historical?: boolean;
}

export interface ScannerState {
  symbols: string[];
  alerts: Alert[];
  isConnected: boolean;
  lastUpdate: number;
}

export interface SymbolData {
  symbol: string;
  lastPrice: number;
  gapPercent: number;
  volume: number;
  hod: number;
  bid: number;
  ask: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  volume: number;
  timestamp: number;
  high: number;
  low: number;
  open: number;
  close: number;
}

export interface BarData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

