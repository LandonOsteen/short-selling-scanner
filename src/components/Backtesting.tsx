import React, { useState, useCallback, memo } from 'react';
import './Backtesting.css';
import { Alert, PatternType } from '../types';
import { GapScanner } from '../services/GapScanner';

interface BacktestingProps {
  gapScanner: GapScanner;
}

interface Trade {
  id: string;
  symbol: string;
  date: string;
  strategy: PatternType;
  entryTime: string;
  entryPrice: number;
  exitPrice: number; // Market open price
  pnl: number;
  pnlPercent: number;
  isWin: boolean;
  signalDetail: string;
  volume: number;
  gapPercent: number;
  minutesToOpen: number;
}

interface BacktestResults {
  trades: Trade[];
  totalTrades: number;
  totalPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  profitFactor: number;
  startDate: string;
  endDate: string;
  strategy: PatternType | 'all';
}

const STRATEGIES = [
  { value: 'all', label: 'All Strategies' },
  { value: 'ToppingTail1m', label: 'Topping Tail 1m' },
  { value: 'HODBreakCloseUnder', label: 'HOD Break Close Under' },
  { value: 'Run4PlusGreenThenRed', label: '4+ Green Then Red' },
] as const;

const Backtesting: React.FC<BacktestingProps> = ({ gapScanner }) => {
  const [strategy, setStrategy] = useState<PatternType | 'all'>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<BacktestResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatDate = useCallback((dateString: string): string => {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }, []);

  const validateDateRange = useCallback((): string | null => {
    if (!startDate || !endDate) {
      return 'Please select both start and end dates';
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date();

    if (start >= today || end >= today) {
      return 'Both dates must be in the past';
    }

    if (start >= end) {
      return 'Start date must be before end date';
    }

    // Check for reasonable date range (warn for very large ranges)
    const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 365) {
      console.warn(`Large date range detected: ${daysDiff} days. This may take a while to process.`);
    }

    return null;
  }, [startDate, endDate]);

  const getBusinessDays = useCallback((start: string, end: string): string[] => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const businessDays: string[] = [];

    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dayOfWeek = currentDate.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Not Sunday or Saturday
        businessDays.push(currentDate.toISOString().split('T')[0]);
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return businessDays;
  }, []);

  const runBacktest = useCallback(async () => {
    const validationError = validateDateRange();
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsRunning(true);
    setError(null);
    setResults(null);

    try {
      console.log(`Starting backtest: ${strategy} from ${startDate} to ${endDate}`);

      const businessDays = getBusinessDays(startDate, endDate);
      console.log(`Testing ${businessDays.length} business days`);

      const allTrades: Trade[] = [];

      for (const date of businessDays) {
        try {
          console.log(`Processing ${date}...`);

          // Get all alerts for this date
          const dayAlerts = await gapScanner.getHistoricalAlertsForDate(date);

          // Filter by strategy if not 'all'
          const filteredAlerts = strategy === 'all'
            ? dayAlerts
            : dayAlerts.filter(alert => alert.type === strategy);

          // Group by symbol and get first signal for each symbol
          const firstSignalsPerSymbol = new Map<string, Alert>();

          filteredAlerts
            .sort((a, b) => a.timestamp - b.timestamp) // Sort by time
            .forEach(alert => {
              if (!firstSignalsPerSymbol.has(alert.symbol)) {
                firstSignalsPerSymbol.set(alert.symbol, alert);
              }
            });

          // Process each first signal
          for (const symbol of Array.from(firstSignalsPerSymbol.keys())) {
            const alert = firstSignalsPerSymbol.get(symbol)!;
            try {
              // Get market open price for the next trading day
              const nextDay = new Date(date);
              nextDay.setDate(nextDay.getDate() + 1);

              // Skip weekends for next day
              while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
                nextDay.setDate(nextDay.getDate() + 1);
              }

              const nextDayStr = nextDay.toISOString().split('T')[0];
              const openPrice = await gapScanner.getMarketOpenPrice(symbol, nextDayStr);

              if (openPrice > 0) {
                // Calculate P&L for short position (1000 shares)
                // Short: Sell at entry price, buy at exit price
                // Profit when exit price < entry price
                const shareSize = 1000;
                const pnl = (alert.price - openPrice) * shareSize;
                const pnlPercent = ((alert.price - openPrice) / alert.price) * 100;
                const isWin = pnl > 0;

                // Calculate minutes until market open (9:30 AM ET)
                const signalTime = new Date(alert.timestamp);
                const marketOpen = new Date(signalTime);
                marketOpen.setHours(9, 30, 0, 0); // 9:30 AM ET
                const minutesToOpen = Math.round((marketOpen.getTime() - signalTime.getTime()) / (1000 * 60));

                const trade: Trade = {
                  id: `${symbol}-${date}-${alert.type}`,
                  symbol,
                  date,
                  strategy: alert.type,
                  entryTime: new Date(alert.timestamp).toLocaleTimeString('en-US', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit'
                  }),
                  entryPrice: alert.price,
                  exitPrice: openPrice,
                  pnl,
                  pnlPercent,
                  isWin,
                  signalDetail: alert.detail,
                  volume: alert.volume || 0,
                  gapPercent: alert.gapPercent || 0,
                  minutesToOpen: minutesToOpen
                };

                allTrades.push(trade);
              }
            } catch (error) {
              console.warn(`Failed to get open price for ${symbol} on ${date}:`, error);
            }
          }

        } catch (error) {
          console.warn(`Failed to process ${date}:`, error);
        }
      }

      // Calculate statistics
      const totalTrades = allTrades.length;
      const winningTrades = allTrades.filter(t => t.isWin);
      const losingTrades = allTrades.filter(t => !t.isWin);

      const totalPnL = allTrades.reduce((sum, trade) => sum + trade.pnl, 0);
      const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;

      const avgWin = winningTrades.length > 0
        ? winningTrades.reduce((sum, trade) => sum + trade.pnl, 0) / winningTrades.length
        : 0;

      const avgLoss = losingTrades.length > 0
        ? losingTrades.reduce((sum, trade) => sum + trade.pnl, 0) / losingTrades.length
        : 0;

      const maxWin = winningTrades.length > 0
        ? Math.max(...winningTrades.map(t => t.pnl))
        : 0;

      const maxLoss = losingTrades.length > 0
        ? Math.min(...losingTrades.map(t => t.pnl))
        : 0;

      const totalWinAmount = winningTrades.reduce((sum, trade) => sum + trade.pnl, 0);
      const totalLossAmount = Math.abs(losingTrades.reduce((sum, trade) => sum + trade.pnl, 0));
      const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : 0;

      const backtestResults: BacktestResults = {
        trades: allTrades.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
        totalTrades,
        totalPnL,
        winRate,
        avgWin,
        avgLoss,
        maxWin,
        maxLoss,
        profitFactor,
        startDate,
        endDate,
        strategy
      };

      setResults(backtestResults);
      console.log(`Backtest completed: ${totalTrades} trades, $${totalPnL.toFixed(2)} P&L`);

    } catch (error) {
      console.error('Backtest failed:', error);
      setError(`Backtest failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsRunning(false);
    }
  }, [startDate, endDate, strategy, gapScanner, validateDateRange, getBusinessDays]);

  return (
    <div className="backtesting">
      <div className="backtesting-header">
        <div className="header-title">
          <span className="header-label">STRATEGY BACKTESTING</span>
          <span className="header-subtitle">Test signal performance across date ranges • 1000 shares per trade</span>
        </div>
      </div>

      <div className="backtest-controls">
        <div className="control-group">
          <label htmlFor="strategy-select">Strategy:</label>
          <select
            id="strategy-select"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as PatternType | 'all')}
            disabled={isRunning}
            className="control-select"
          >
            {STRATEGIES.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label htmlFor="start-date">Start Date:</label>
          <input
            id="start-date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            max={new Date().toISOString().split('T')[0]}
            disabled={isRunning}
            className="control-input"
          />
        </div>

        <div className="control-group">
          <label htmlFor="end-date">End Date:</label>
          <input
            id="end-date"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            max={new Date().toISOString().split('T')[0]}
            disabled={isRunning}
            className="control-input"
          />
        </div>

        <button
          className={`backtest-button ${isRunning ? 'running' : ''}`}
          onClick={runBacktest}
          disabled={isRunning || !startDate || !endDate}
        >
          {isRunning ? 'RUNNING BACKTEST...' : 'RUN BACKTEST'}
        </button>
      </div>

      {error && (
        <div className="error-message">
          <span className="error-icon">⚠</span>
          <span className="error-text">{error}</span>
        </div>
      )}

      {isRunning && (
        <div className="backtest-progress">
          <div className="progress-spinner"></div>
          <span>Analyzing historical data and market prices...</span>
        </div>
      )}

      {results && (
        <div className="backtest-results">
          <div className="results-summary">
            <h3>Backtest Results</h3>
            <div className="summary-stats">
              <div className="stat-group">
                <div className="stat-item">
                  <span className="stat-label">Total Trades</span>
                  <span className="stat-value">{results.totalTrades}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Total P&L</span>
                  <span className={`stat-value ${results.totalPnL >= 0 ? 'positive' : 'negative'}`}>
                    ${results.totalPnL.toFixed(2)}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Win Rate</span>
                  <span className="stat-value">{results.winRate.toFixed(1)}%</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Profit Factor</span>
                  <span className="stat-value">{results.profitFactor.toFixed(2)}</span>
                </div>
              </div>

              <div className="stat-group">
                <div className="stat-item">
                  <span className="stat-label">Avg Win</span>
                  <span className="stat-value positive">${results.avgWin.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Avg Loss</span>
                  <span className="stat-value negative">${results.avgLoss.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Max Win</span>
                  <span className="stat-value positive">${results.maxWin.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Max Loss</span>
                  <span className="stat-value negative">${results.maxLoss.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="trades-table">
            <h4>Trade Details</h4>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Symbol</th>
                    <th>Strategy</th>
                    <th>Entry Time</th>
                    <th>Mins to Open</th>
                    <th>Volume</th>
                    <th>Gap %</th>
                    <th>Entry Price</th>
                    <th>Exit Price</th>
                    <th>P&L</th>
                    <th>P&L %</th>
                    <th>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {results.trades.map((trade) => (
                    <tr key={trade.id} className={trade.isWin ? 'winning-trade' : 'losing-trade'}>
                      <td>{formatDate(trade.date)}</td>
                      <td className="symbol">{trade.symbol}</td>
                      <td className="strategy">{trade.strategy}</td>
                      <td>{trade.entryTime}</td>
                      <td>{trade.minutesToOpen}m</td>
                      <td>{trade.volume.toLocaleString()}</td>
                      <td className={trade.gapPercent > 0 ? 'positive' : 'negative'}>
                        {trade.gapPercent > 0 ? '+' : ''}{trade.gapPercent.toFixed(1)}%
                      </td>
                      <td>${trade.entryPrice.toFixed(2)}</td>
                      <td>${trade.exitPrice.toFixed(2)}</td>
                      <td className={trade.isWin ? 'positive' : 'negative'}>
                        ${trade.pnl.toFixed(2)}
                      </td>
                      <td className={trade.isWin ? 'positive' : 'negative'}>
                        {trade.pnlPercent.toFixed(1)}%
                      </td>
                      <td className="signal-detail">{trade.signalDetail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(Backtesting);