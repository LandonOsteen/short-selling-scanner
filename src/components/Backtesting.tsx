import React, { useState, useCallback, memo, useMemo } from 'react';
import './Backtesting.css';
import { Alert, PatternType } from '../types';
import { GapScanner } from '../services/GapScanner';
import { getScannerConfig } from '../config/scannerConfig';

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
  exitPrice: number;
  exitTime: string; // Time of exit
  exitStrategy: 'marketOpen' | 'firstGreen5m' | 'firstBreakPrevHigh5m' | 'firstGreenOrBreakPrevHigh5m'; // How we exited
  pnl: number;
  pnlPercent: number;
  isWin: boolean;
  signalDetail: string;
  volume: number;
  gapPercent: number;
  minutesToExit: number; // Time held in minutes
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
  { value: 'ToppingTail5m', label: '5-Minute Topping Tail' },
  { value: 'GreenRunReject', label: 'Green Run Rejection' },
] as const;

const Backtesting: React.FC<BacktestingProps> = ({ gapScanner }) => {
  const [strategy, setStrategy] = useState<PatternType | 'all'>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<BacktestResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Exit strategy
  const [exitStrategy, setExitStrategy] = useState<'marketOpen' | 'firstGreen5m' | 'firstBreakPrevHigh5m' | 'firstGreenOrBreakPrevHigh5m'>('marketOpen');

  // Entry time range (24-hour format)
  const [entryStartTime, setEntryStartTime] = useState('09:30');
  const [entryEndTime, setEntryEndTime] = useState('16:00');

  // Get scanner config for display
  const config = useMemo(() => getScannerConfig(), []);

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
          let filteredAlerts = strategy === 'all'
            ? dayAlerts
            : dayAlerts.filter(alert => alert.type === strategy);

          // Additional filter: Only include signals from CUSTOM entry time range
          const alertsBeforeTimeFilter = filteredAlerts.length;
          const [entryStartHour, entryStartMin] = entryStartTime.split(':').map(Number);
          const [entryEndHour, entryEndMin] = entryEndTime.split(':').map(Number);
          const entryStart = entryStartHour + entryStartMin / 60;
          const entryEnd = entryEndHour + entryEndMin / 60;

          filteredAlerts = filteredAlerts.filter(alert => {
            const alertTime = new Date(alert.timestamp);
            const etTime = new Date(alertTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
            const etHour = etTime.getHours() + etTime.getMinutes() / 60;

            const isWithinHours = etHour >= entryStart && etHour < entryEnd;

            if (!isWithinHours) {
              console.log(`🕐 BACKTESTING FILTER: Excluding ${alert.symbol} signal at ${alertTime.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})} ET (${etHour.toFixed(2)} - outside ${entryStartTime}-${entryEndTime} window)`);
            }

            return isWithinHours;
          });

          if (alertsBeforeTimeFilter > filteredAlerts.length) {
            console.log(`📊 BACKTESTING TIME FILTER: ${date} - Filtered ${alertsBeforeTimeFilter - filteredAlerts.length} signals outside entry hours (${alertsBeforeTimeFilter} → ${filteredAlerts.length})`);
          }

          // For market open exit: group by symbol and get first signal per symbol
          // For first green 5m exit: allow multiple trades per symbol
          let signalsToProcess: Alert[] = [];

          if (exitStrategy === 'marketOpen') {
            // Only take first signal per symbol
            const firstSignalsPerSymbol = new Map<string, Alert>();
            filteredAlerts
              .sort((a, b) => a.timestamp - b.timestamp)
              .forEach(alert => {
                if (!firstSignalsPerSymbol.has(alert.symbol)) {
                  firstSignalsPerSymbol.set(alert.symbol, alert);
                }
              });
            signalsToProcess = Array.from(firstSignalsPerSymbol.values());
          } else {
            // Allow all signals (multiple trades per symbol)
            signalsToProcess = filteredAlerts.sort((a, b) => a.timestamp - b.timestamp);
          }

          // Process each signal
          for (const alert of signalsToProcess) {
            try {
              let exitPrice: number | null = null;
              let exitTime: Date | null = null;
              let minutesToExit: number = 0;

              if (exitStrategy === 'marketOpen') {
                // Exit at next day's market open
                const nextDay = new Date(date);
                nextDay.setDate(nextDay.getDate() + 1);

                // Skip weekends for next day
                while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
                  nextDay.setDate(nextDay.getDate() + 1);
                }

                const nextDayStr = nextDay.toISOString().split('T')[0];
                const openPrice = await gapScanner.getMarketOpenPrice(alert.symbol, nextDayStr);

                if (openPrice <= 0) {
                  console.warn(`No open price for ${alert.symbol} on ${nextDayStr}`);
                  continue;
                }

                exitPrice = openPrice;
                exitTime = new Date(nextDayStr + 'T09:30:00');
                const signalTime = new Date(alert.timestamp);
                minutesToExit = Math.round((exitTime.getTime() - signalTime.getTime()) / (1000 * 60));

              } else {
                // Intraday exit strategies - get 5-minute bars
                const bars5m = await gapScanner['get5MinuteBars'](
                  alert.symbol,
                  new Date(date + 'T00:00:00'),
                  new Date(date + 'T23:59:59')
                );

                if (!bars5m || bars5m.length === 0) {
                  console.warn(`No 5m bars for ${alert.symbol} on ${date}`);
                  continue;
                }

                const signalTime = new Date(alert.timestamp);
                let foundExit = false;

                // Find the index where we entered (first bar after signal)
                let entryBarIndex = -1;
                for (let i = 0; i < bars5m.length; i++) {
                  if (new Date(bars5m[i].t).getTime() > signalTime.getTime()) {
                    entryBarIndex = i;
                    break;
                  }
                }

                if (entryBarIndex === -1) {
                  console.warn(`No bars after entry for ${alert.symbol} on ${date}`);
                  continue;
                }

                // Iterate through bars after entry
                for (let i = entryBarIndex; i < bars5m.length; i++) {
                  const bar = bars5m[i];
                  const barTime = new Date(bar.t);

                  // Check if it's a completed 5-minute candle (aligned to 0 or 5 minutes)
                  const etBarTime = new Date(barTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
                  const minutes = etBarTime.getMinutes();
                  const seconds = etBarTime.getSeconds();
                  const isProperlyAligned = minutes % 5 === 0 && seconds === 0;

                  if (!isProperlyAligned) {
                    continue; // Skip misaligned bars
                  }

                  // Check exit conditions based on strategy
                  let shouldExit = false;

                  if (exitStrategy === 'firstGreen5m') {
                    // Exit on first green candle
                    const isGreen = bar.c > bar.o;
                    shouldExit = isGreen;

                  } else if (exitStrategy === 'firstBreakPrevHigh5m') {
                    // Exit when candle breaks previous candle's high
                    if (i > entryBarIndex) {
                      const prevBar = bars5m[i - 1];
                      const breaksPrevHigh = bar.h > prevBar.h;
                      shouldExit = breaksPrevHigh;
                    }

                  } else if (exitStrategy === 'firstGreenOrBreakPrevHigh5m') {
                    // Exit on whichever happens first: green candle OR breaks previous high
                    const isGreen = bar.c > bar.o;
                    let breaksPrevHigh = false;
                    if (i > entryBarIndex) {
                      const prevBar = bars5m[i - 1];
                      breaksPrevHigh = bar.h > prevBar.h;
                    }
                    shouldExit = isGreen || breaksPrevHigh;
                  }

                  if (shouldExit) {
                    exitPrice = bar.c;
                    exitTime = barTime;
                    minutesToExit = Math.round((barTime.getTime() - signalTime.getTime()) / (1000 * 60));
                    foundExit = true;
                    break;
                  }
                }

                if (!foundExit) {
                  console.warn(`No exit found for ${exitStrategy} for ${alert.symbol} on ${date}`);
                  continue; // Skip this trade if no exit found
                }
              }

              // Validate we have exit data
              if (exitPrice === null || exitTime === null) {
                console.warn(`Missing exit data for ${alert.symbol} on ${date}`);
                continue;
              }

              // Calculate P&L for short position (1000 shares)
              const shareSize = 1000;
              const pnl = (alert.price - exitPrice) * shareSize;
              const pnlPercent = ((alert.price - exitPrice) / alert.price) * 100;
              const isWin = pnl > 0;

              const trade: Trade = {
                id: `${alert.symbol}-${date}-${alert.timestamp}-${alert.type}`,
                symbol: alert.symbol,
                date,
                strategy: alert.type,
                entryTime: new Date(alert.timestamp).toLocaleTimeString('en-US', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'America/New_York'
                }),
                entryPrice: alert.price,
                exitPrice: exitPrice,
                exitTime: exitTime.toLocaleTimeString('en-US', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'America/New_York'
                }),
                exitStrategy: exitStrategy,
                pnl,
                pnlPercent,
                isWin,
                signalDetail: alert.detail,
                volume: alert.volume || 0,
                gapPercent: alert.gapPercent || 0,
                minutesToExit: minutesToExit
              };

              allTrades.push(trade);
            } catch (error) {
              console.warn(`Failed to process trade for ${alert.symbol} on ${date}:`, error);
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
  }, [startDate, endDate, strategy, exitStrategy, entryStartTime, entryEndTime, gapScanner, validateDateRange, getBusinessDays]);

  return (
    <div className="backtesting">
      <div className="backtesting-header">
        <div className="header-title">
          <span className="header-label">STRATEGY BACKTESTING</span>
          <span className="header-subtitle">Test 5-minute pattern performance • 1000 shares per trade • Customizable entry times & exit strategies</span>
        </div>
        <div className="config-display">
          <span className="config-item">
            <span className="config-label">Hours:</span> {config.marketHours.startTime} - {config.marketHours.endTime} ET
          </span>
          <span className="config-item">
            <span className="config-label">Price:</span> ${config.gapCriteria.minPrice} - ${config.gapCriteria.maxPrice}
          </span>
          <span className="config-item">
            <span className="config-label">Volume:</span> {(config.gapCriteria.minCumulativeVolume / 1000).toFixed(0)}K+
          </span>
          <span className="config-item">
            <span className="config-label">Gap:</span> {config.gapCriteria.minGapPercentage}%+
          </span>
          <span className="config-item">
            <span className="config-label">5m TT Close:</span> {config.patterns.toppingTail5m.minClosePercent}%+
          </span>
          <span className="config-item">
            <span className="config-label">5m TT Shadow:</span> {config.patterns.toppingTail5m.minShadowToBodyRatio}x+
          </span>
          <span className="config-item">
            <span className="config-label">5m TT HOD:</span> {config.patterns.toppingTail5m.requireStrictHODBreak ? 'Strict Break' : `${config.patterns.toppingTail5m.maxHighDistanceFromHODPercent}% max`}
          </span>
          <span className="config-item">
            <span className="config-label">Green Run:</span> {config.patterns.greenRun.minConsecutiveGreen}+ candles
          </span>
          <span className="config-item">
            <span className="config-label">HOD Distance:</span> {config.patterns.greenRun.maxDistanceFromHODPercent}% max
          </span>
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

        <div className="control-group">
          <label htmlFor="exit-strategy">Exit Strategy:</label>
          <select
            id="exit-strategy"
            value={exitStrategy}
            onChange={(e) => setExitStrategy(e.target.value as 'marketOpen' | 'firstGreen5m' | 'firstBreakPrevHigh5m' | 'firstGreenOrBreakPrevHigh5m')}
            disabled={isRunning}
            className="control-select"
          >
            <option value="marketOpen">Close at Market Open</option>
            <option value="firstGreen5m">First Green 5m Candle</option>
            <option value="firstBreakPrevHigh5m">First Break Prev High 5m</option>
            <option value="firstGreenOrBreakPrevHigh5m">First Green OR Break Prev High 5m</option>
          </select>
        </div>

        <div className="control-group">
          <label htmlFor="entry-start-time">Entry Start Time:</label>
          <input
            id="entry-start-time"
            type="time"
            value={entryStartTime}
            onChange={(e) => setEntryStartTime(e.target.value)}
            disabled={isRunning}
            className="control-input"
          />
        </div>

        <div className="control-group">
          <label htmlFor="entry-end-time">Entry End Time:</label>
          <input
            id="entry-end-time"
            type="time"
            value={entryEndTime}
            onChange={(e) => setEntryEndTime(e.target.value)}
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
                    <th>Exit Time</th>
                    <th>Exit Type</th>
                    <th>Hold Time</th>
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
                      <td>{trade.exitTime}</td>
                      <td className="exit-strategy">
                        {trade.exitStrategy === 'marketOpen' ? 'Market Open' :
                         trade.exitStrategy === 'firstGreen5m' ? '1st Green 5m' :
                         trade.exitStrategy === 'firstBreakPrevHigh5m' ? '1st Break Prev High' :
                         '1st Green/Break High'}
                      </td>
                      <td>{trade.minutesToExit}m</td>
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