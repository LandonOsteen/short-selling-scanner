export type PatternType =
  | 'ToppingTail1m'
  | 'ToppingTail5m'
  | 'HODBreakCloseUnder'
  | 'New1mLowNearHOD'
  | 'EMA200Reject'
  | 'DoubleTop'
  | 'TripleTop'
  | 'Run4PlusGreenThenRed';

export interface Alert {
  id: string;
  timestamp: number;
  symbol: string;
  type: PatternType;
  detail: string;
  price: number;
  volume: number;
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

export interface PatternConfig {
  title: string;
  color: string;
  priority: number;
  description: string;
}

export interface ScannerWindowProps {
  title: string;
  color: string;
  priority: number;
  alerts: Alert[];
  pattern: PatternType;
}

export interface StatusBarProps {
  isConnected: boolean;
  stats: {
    totalAlerts: number;
    symbolsTracked: number;
    lastUpdate: string;
  };
  symbols: string[];
}