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
  isBreakeven: boolean; // True when entry price = exit price
  signalDetail: string;
  volume: number;
  gapPercent: number;
  minutesToExit: number; // Time held in minutes
  mae: number; // Maximum Adverse Excursion - highest price reached after entry (for shorts)
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
  breakevenCount: number;
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
  const [entryStartTime, setEntryStartTime] = useState('06:30');
  const [entryEndTime, setEntryEndTime] = useState('09:20');

  // Stop loss controls for risk modeling
  const [stopLossAmount, setStopLossAmount] = useState<number>(0); // Dollar amount per share
  const [stopLossPercent, setStopLossPercent] = useState<number>(0); // Percentage

  // Share size for position sizing
  const [shareSize, setShareSize] = useState<number>(1000); // Number of shares per trade

  // Get scanner config for display
  const config = useMemo(() => getScannerConfig(), []);

  // Adjust results based on stop loss settings and share size (without re-fetching data)
  const adjustedResults = useMemo((): BacktestResults | null => {
    if (!results) return null;

    // Always recalculate trades to account for share size and stop loss changes
    const adjustedTrades = results.trades.map(trade => {
      // Calculate stop loss threshold if stop loss is active
      const hasStopLoss = stopLossAmount > 0 || stopLossPercent > 0;
      let stopLossThreshold: number = 0;

      if (hasStopLoss) {
        if (stopLossAmount > 0) {
          // Use dollar amount
          stopLossThreshold = stopLossAmount;
        } else {
          // Use percentage
          stopLossThreshold = trade.entryPrice * (stopLossPercent / 100);
        }
      }

      // Check if MAE exceeds stop loss (trade would have been stopped out)
      if (hasStopLoss && trade.mae > stopLossThreshold) {
        // Recalculate P&L as if stopped out
        // For shorts: entry at X, stopped at X + stopLossThreshold
        const stoppedOutPrice = trade.entryPrice + stopLossThreshold;
        const adjustedPnl = (trade.entryPrice - stoppedOutPrice) * shareSize; // Always a loss
        const adjustedPnlPercent = ((trade.entryPrice - stoppedOutPrice) / trade.entryPrice) * 100;

        return {
          ...trade,
          pnl: adjustedPnl,
          pnlPercent: adjustedPnlPercent,
          isWin: false,
          isBreakeven: false,
          exitPrice: stoppedOutPrice,
          exitTime: 'Stopped Out',
          exitStrategy: 'marketOpen' as const // Keep original for grouping purposes
        };
      }

      // Trade was not stopped out - recalculate P&L with current share size
      const recalculatedPnl = (trade.entryPrice - trade.exitPrice) * shareSize;
      const recalculatedPnlPercent = ((trade.entryPrice - trade.exitPrice) / trade.entryPrice) * 100;

      return {
        ...trade,
        pnl: recalculatedPnl,
        pnlPercent: recalculatedPnlPercent,
        isWin: recalculatedPnl > 0,
        isBreakeven: trade.entryPrice === trade.exitPrice
      };
    });

    // Recalculate summary statistics
    const wins = adjustedTrades.filter(t => t.isWin);
    const losses = adjustedTrades.filter(t => !t.isWin && !t.isBreakeven);
    const breakevenCount = adjustedTrades.filter(t => t.isBreakeven).length;

    const totalPnL = adjustedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length : 0;
    const maxWin = wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0;
    const maxLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;

    const totalWinAmount = wins.reduce((sum, t) => sum + t.pnl, 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? 999 : 0;

    const winRate = adjustedTrades.length > 0
      ? (wins.length / (adjustedTrades.length - breakevenCount)) * 100
      : 0;

    return {
      ...results,
      trades: adjustedTrades,
      totalPnL,
      winRate,
      avgWin,
      avgLoss,
      maxWin,
      maxLoss,
      profitFactor,
      breakevenCount
    };
  }, [results, stopLossAmount, stopLossPercent, shareSize]);

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

      // OPTIMIZATION 1: Pre-fetch ALL grouped daily data upfront
      console.log(`⚡ Pre-fetching grouped daily data for all dates...`);
      const config = getScannerConfig();
      const minDailyVolume = config.historical.minDailyVolume;
      const polygonApiKey = (gapScanner as any).polygonApiKey;

      // Global cache shared across all date processing
      const dailyDataCache = new Map<string, Map<string, any>>();

      // Helper function to fetch and cache grouped daily data
      const fetchDailyData = async (dateStr: string) => {
        if (dailyDataCache.has(dateStr)) {
          return dailyDataCache.get(dateStr)!;
        }

        const symbolData = new Map<string, any>();
        try {
          const groupedUrl = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${polygonApiKey}`;
          const response = await fetch(groupedUrl);
          const data = await response.json();

          if (data.results) {
            data.results.forEach((bar: any) => {
              if (bar.T) {
                symbolData.set(bar.T, bar);
              }
            });
          }
          dailyDataCache.set(dateStr, symbolData);
        } catch (error) {
          console.warn(`Failed to fetch daily data for ${dateStr}:`, error);
        }
        return symbolData;
      };

      // Pre-fetch all entry dates + potential exit dates (next business day for each)
      const allDatesToFetch = new Set<string>(businessDays);
      businessDays.forEach(date => {
        const [year, month, day] = date.split('-').map(Number);
        let nextDay = new Date(year, month - 1, day);
        nextDay.setDate(nextDay.getDate() + 1);
        // Skip weekends
        while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
          nextDay.setDate(nextDay.getDate() + 1);
        }
        const nextDayStr = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, '0')}-${String(nextDay.getDate()).padStart(2, '0')}`;
        allDatesToFetch.add(nextDayStr);
      });

      // Fetch all dates in parallel (batch of 10)
      const datesToFetchArray = Array.from(allDatesToFetch);
      const PREFETCH_BATCH_SIZE = 10;
      for (let i = 0; i < datesToFetchArray.length; i += PREFETCH_BATCH_SIZE) {
        const batch = datesToFetchArray.slice(i, i + PREFETCH_BATCH_SIZE);
        await Promise.all(batch.map(date => fetchDailyData(date)));
        console.log(`   Fetched ${Math.min(i + PREFETCH_BATCH_SIZE, datesToFetchArray.length)}/${datesToFetchArray.length} dates`);
      }
      console.log(`✅ Pre-fetch complete! Cached data for ${dailyDataCache.size} dates`);

      // OPTIMIZATION 2: Process dates in parallel batches
      const allTrades: Trade[] = [];
      const BATCH_SIZE = 3; // Process 3 dates at a time

      for (let batchStart = 0; batchStart < businessDays.length; batchStart += BATCH_SIZE) {
        const batch = businessDays.slice(batchStart, Math.min(batchStart + BATCH_SIZE, businessDays.length));
        console.log(`\n🔄 Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}: ${batch.join(', ')}`);

        // Process each date in the batch in parallel
        const batchTrades = await Promise.all(batch.map(async (date) => {
          try {
            // Get all alerts for this date
            const dayAlerts = await gapScanner.getHistoricalAlertsForDate(date);

            // Fetch current date's data (should be cached from pre-fetch)
            const currentDateData = await fetchDailyData(date);

            // Volume filter using cached data
            let volumeFilteredAlerts = dayAlerts;
            if (minDailyVolume > 0 && currentDateData.size > 0) {
              const beforeVolumeFilter = volumeFilteredAlerts.length;
              volumeFilteredAlerts = dayAlerts.filter(alert => {
                const bar = currentDateData.get(alert.symbol);
                const dailyVolume = bar?.v || 0;
                return dailyVolume >= minDailyVolume;
              });

              const filteredCount = beforeVolumeFilter - volumeFilteredAlerts.length;
              if (filteredCount > 0) {
                console.log(`   📊 ${date}: Filtered ${filteredCount} low-volume signals (< ${(minDailyVolume/1000).toFixed(0)}K daily volume)`);
              }
            }

            // Filter by strategy if not 'all'
            let filteredAlerts = strategy === 'all'
              ? volumeFilteredAlerts
              : volumeFilteredAlerts.filter(alert => alert.type === strategy);

            // Additional filter: Only include signals from CUSTOM entry time range
            const [entryStartHour, entryStartMin] = entryStartTime.split(':').map(Number);
            const [entryEndHour, entryEndMin] = entryEndTime.split(':').map(Number);
            const entryStart = entryStartHour + entryStartMin / 60;
            const entryEnd = entryEndHour + entryEndMin / 60;

            filteredAlerts = filteredAlerts.filter(alert => {
              const alertTime = new Date(alert.timestamp);
              const etTime = new Date(alertTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
              const etHour = etTime.getHours() + etTime.getMinutes() / 60;
              return etHour >= entryStart && etHour < entryEnd;
            });

            // For market open exit: group by symbol and get first signal per symbol
            let signalsToProcess: Alert[] = [];
            if (exitStrategy === 'marketOpen') {
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
              signalsToProcess = filteredAlerts.sort((a, b) => a.timestamp - b.timestamp);
            }

            // Process each signal and collect trades for this date
            const dateTrades: Trade[] = [];
            for (const alert of signalsToProcess) {
            try {
              let exitPrice: number | null = null;
              let exitTime: Date | null = null;
              let minutesToExit: number = 0;

              if (exitStrategy === 'marketOpen') {
                // Determine which day's market open to use
                const signalTime = new Date(alert.timestamp);

                // Get signal time in ET hours (convert to ET timezone)
                const etSignalTimeStr = signalTime.toLocaleString("en-US", {timeZone: "America/New_York", hour12: false});
                const etTimeParts = etSignalTimeStr.match(/(\d{1,2}):(\d{2}):(\d{2})/);

                if (!etTimeParts) {
                  console.warn(`Could not parse ET time for ${alert.symbol}: ${etSignalTimeStr}`);
                  continue; // Skip this trade if we can't parse the time
                }

                const signalHour = parseInt(etTimeParts[1]) + parseInt(etTimeParts[2]) / 60;

                // If signal is before 9:30 AM (9.5 hours), exit at same day's open
                // Otherwise, exit at next day's open
                const [year, month, day] = date.split('-').map(Number);
                let exitDate = new Date(year, month - 1, day); // Create date in local timezone

                if (signalHour >= 9.5) {
                  // Signal after market open - exit next day
                  exitDate.setDate(exitDate.getDate() + 1);
                }

                // Skip weekends for exit date
                while (exitDate.getDay() === 0 || exitDate.getDay() === 6) {
                  exitDate.setDate(exitDate.getDate() + 1);
                }

                const exitDateStr = `${exitDate.getFullYear()}-${String(exitDate.getMonth() + 1).padStart(2, '0')}-${String(exitDate.getDate()).padStart(2, '0')}`;

                // OPTIMIZATION: Look up open price from cached grouped daily data
                // This avoids individual API calls per symbol (10-15x speedup)
                let openPrice = 0;

                // Fetch exit date's data if not already cached
                const exitDateData = await fetchDailyData(exitDateStr);

                // Look up open price from cached data
                const exitBar = exitDateData.get(alert.symbol);
                if (exitBar && exitBar.o) {
                  openPrice = exitBar.o;
                } else {
                  // Fallback: try individual API call if not in grouped data
                  console.log(`⚠️  ${alert.symbol} not in grouped data for ${exitDateStr}, fetching individually...`);
                  openPrice = await gapScanner.getMarketOpenPrice(alert.symbol, exitDateStr);
                }

                if (openPrice <= 0) {
                  console.warn(`No open price for ${alert.symbol} on ${exitDateStr}`);
                  continue;
                }

                exitPrice = openPrice;

                // Create exit time: 9:30 AM ET on exit date
                // Note: For display purposes only - actual exit time string is hardcoded below
                exitTime = new Date(exitDateStr + 'T09:30:00'); // Placeholder Date object

                // Calculate hold time: from signal to 9:30 AM ET on exit date
                // Convert both to ET times for accurate calculation
                const signalETStr = signalTime.toLocaleString("en-US", {timeZone: "America/New_York"});
                const exitETStr = "09:30:00";

                // Calculate days difference
                const signalDate = new Date(signalETStr).setHours(0, 0, 0, 0);
                const exitDateObj = new Date(exitDateStr).setHours(0, 0, 0, 0);
                const daysDiff = Math.round((exitDateObj - signalDate) / (1000 * 60 * 60 * 24));

                // Calculate time from signal to 9:30 AM
                const signalETHours = parseInt(etTimeParts[1]);
                const signalETMinutes = parseInt(etTimeParts[2]);
                const signalMinutesFromMidnight = signalETHours * 60 + signalETMinutes;
                const exitMinutesFromMidnight = 9 * 60 + 30; // 9:30 AM

                minutesToExit = (daysDiff * 24 * 60) + (exitMinutesFromMidnight - signalMinutesFromMidnight);

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

              // Calculate Maximum Adverse Excursion (MAE) - highest price after entry until exit
              // For shorts, this is the worst move against us (price going up)
              let mae = 0;

              try {
                // Fetch 5-minute bars to calculate MAE
                const bars5mForMAE = await gapScanner['get5MinuteBars'](
                  alert.symbol,
                  new Date(date + 'T00:00:00'),
                  new Date(date + 'T23:59:59')
                );

                if (bars5mForMAE && bars5mForMAE.length > 0) {
                  const signalTime = new Date(alert.timestamp);
                  const exitTimestamp = exitTime instanceof Date ? exitTime.getTime() : new Date(date + 'T09:30:00').getTime();

                  // Find highest high from bars after entry until exit
                  let highestHigh = alert.price; // Start with entry price

                  for (const bar of bars5mForMAE) {
                    const barTime = new Date(bar.t).getTime();
                    // Only consider bars after entry and before/at exit
                    if (barTime > signalTime.getTime() && barTime <= exitTimestamp) {
                      if (bar.h > highestHigh) {
                        highestHigh = bar.h;
                      }
                    }
                  }

                  // MAE is the difference between highest high and entry price (for shorts)
                  mae = highestHigh - alert.price;
                }
              } catch (error) {
                console.warn(`Failed to calculate MAE for ${alert.symbol}: ${error}`);
                mae = 0;
              }

              // Calculate P&L for short position
              const pnl = (alert.price - exitPrice) * shareSize;
              const pnlPercent = ((alert.price - exitPrice) / alert.price) * 100;
              const isBreakeven = alert.price === exitPrice;
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
                exitTime: exitStrategy === 'marketOpen'
                  ? '09:30'  // Market open is always 9:30 AM ET
                  : exitTime.toLocaleTimeString('en-US', {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'America/New_York'
                    }),
                exitStrategy: exitStrategy,
                pnl,
                pnlPercent,
                isWin,
                isBreakeven,
                signalDetail: alert.detail,
                volume: alert.volume || 0,
                gapPercent: alert.gapPercent || 0,
                minutesToExit: minutesToExit,
                mae: mae
              };

              dateTrades.push(trade);
            } catch (error) {
              console.warn(`Failed to process trade for ${alert.symbol} on ${date}:`, error);
            }
            }

            return dateTrades;
          } catch (error) {
            console.warn(`Failed to process ${date}:`, error);
            return [];
          }
        }));

        // Flatten batch trades and add to all trades
        const flattenedBatchTrades = batchTrades.flat();
        allTrades.push(...flattenedBatchTrades);
        console.log(`   ✅ Batch complete: ${flattenedBatchTrades.length} trades processed (Total: ${allTrades.length})`);
      }

      // Calculate statistics
      const totalTrades = allTrades.length;
      const breakevenTrades = allTrades.filter(t => t.isBreakeven);
      const winningTrades = allTrades.filter(t => t.isWin && !t.isBreakeven);
      const losingTrades = allTrades.filter(t => !t.isWin && !t.isBreakeven);
      const breakevenCount = breakevenTrades.length;

      const totalPnL = allTrades.reduce((sum, trade) => sum + trade.pnl, 0);

      // Win rate excludes breakeven trades (wins / (wins + losses))
      const tradesWithOutcome = winningTrades.length + losingTrades.length;
      const winRate = tradesWithOutcome > 0 ? (winningTrades.length / tradesWithOutcome) * 100 : 0;

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
        breakevenCount,
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
  }, [startDate, endDate, strategy, exitStrategy, entryStartTime, entryEndTime, shareSize, gapScanner, validateDateRange, getBusinessDays]);

  // Group trades by date for calendar view
  const tradesByDate = useMemo(() => {
    if (!adjustedResults) return new Map<string, { pnl: number; trades: Trade[] }>();

    const grouped = new Map<string, { pnl: number; trades: Trade[] }>();

    adjustedResults.trades.forEach(trade => {
      const existing = grouped.get(trade.date);
      if (existing) {
        existing.pnl += trade.pnl;
        existing.trades.push(trade);
      } else {
        grouped.set(trade.date, { pnl: trade.pnl, trades: [trade] });
      }
    });

    return grouped;
  }, [adjustedResults]);

  // Generate calendar data for the date range
  const calendarData = useMemo(() => {
    if (!adjustedResults) return [];

    const start = new Date(adjustedResults.startDate);
    const end = new Date(adjustedResults.endDate);

    // Get all months in the range
    const months: Array<{
      year: number;
      month: number;
      monthName: string;
      days: Array<{
        date: string;
        dayOfMonth: number;
        isWeekend: boolean;
        hasData: boolean;
        pnl: number;
        tradeCount: number;
      }>;
    }> = [];

    let currentDate = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);

    while (currentDate <= endMonth) {
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth();
      const monthName = currentDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });

      const firstDayOfMonth = new Date(year, month, 1);
      const lastDayOfMonth = new Date(year, month + 1, 0);
      const startingDayOfWeek = firstDayOfMonth.getDay(); // 0 = Sunday

      const days: Array<{
        date: string;
        dayOfMonth: number;
        isWeekend: boolean;
        hasData: boolean;
        pnl: number;
        tradeCount: number;
      }> = [];

      // Add empty cells for days before month starts
      for (let i = 0; i < startingDayOfWeek; i++) {
        days.push({
          date: '',
          dayOfMonth: 0,
          isWeekend: false,
          hasData: false,
          pnl: 0,
          tradeCount: 0
        });
      }

      // Add all days of the month
      for (let day = 1; day <= lastDayOfMonth.getDate(); day++) {
        const date = new Date(year, month, day);
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayData = tradesByDate.get(dateStr);
        const isWeekend = date.getDay() === 0 || date.getDay() === 6;

        // Only include dates within backtest range
        const isInRange = date >= start && date <= end;

        days.push({
          date: dateStr,
          dayOfMonth: day,
          isWeekend,
          hasData: isInRange && !!dayData,
          pnl: dayData?.pnl || 0,
          tradeCount: dayData?.trades.length || 0
        });
      }

      months.push({ year, month, monthName, days });
      currentDate = new Date(year, month + 1, 1);
    }

    return months;
  }, [adjustedResults, tradesByDate]);

  const downloadCSV = useCallback(() => {
    if (!adjustedResults) return;

    // Prepare CSV content
    const csvRows: string[] = [];

    // Add summary section
    csvRows.push('BACKTEST SUMMARY');
    csvRows.push(`Strategy,${adjustedResults.strategy}`);
    csvRows.push(`Date Range,${adjustedResults.startDate} to ${adjustedResults.endDate}`);
    csvRows.push(`Total Trades,${adjustedResults.totalTrades}`);
    csvRows.push(`Breakeven Trades,${adjustedResults.breakevenCount}`);
    csvRows.push(`Total P&L,$${adjustedResults.totalPnL.toFixed(2)}`);
    csvRows.push(`Win Rate,${adjustedResults.winRate.toFixed(1)}%`);
    csvRows.push(`Avg Win,$${adjustedResults.avgWin.toFixed(2)}`);
    csvRows.push(`Avg Loss,$${adjustedResults.avgLoss.toFixed(2)}`);
    csvRows.push(`Max Win,$${adjustedResults.maxWin.toFixed(2)}`);
    csvRows.push(`Max Loss,$${adjustedResults.maxLoss.toFixed(2)}`);
    csvRows.push(`Profit Factor,${adjustedResults.profitFactor.toFixed(2)}`);
    csvRows.push('');
    csvRows.push('');

    // Add trade details header
    csvRows.push('TRADE DETAILS');
    const headers = [
      'Date',
      'Symbol',
      'Strategy',
      'Entry Time',
      'Exit Time',
      'Exit Type',
      'Hold Time (min)',
      'Volume',
      'Gap %',
      'Entry Price',
      'Exit Price',
      'P&L',
      'P&L %',
      'MAE',
      'Result',
      'Signal'
    ];
    csvRows.push(headers.join(','));

    // Add trade rows
    adjustedResults.trades.forEach(trade => {
      const result = trade.isBreakeven ? 'Breakeven' : trade.isWin ? 'Win' : 'Loss';
      const exitTypeLabel =
        trade.exitStrategy === 'marketOpen' ? 'Market Open' :
        trade.exitStrategy === 'firstGreen5m' ? '1st Green 5m' :
        trade.exitStrategy === 'firstBreakPrevHigh5m' ? '1st Break Prev High' :
        '1st Green/Break High';

      const row = [
        trade.date,
        trade.symbol,
        trade.strategy,
        trade.entryTime,
        trade.exitTime,
        exitTypeLabel,
        trade.minutesToExit.toString(),
        trade.volume.toString(),
        trade.gapPercent.toFixed(1),
        trade.entryPrice.toFixed(2),
        trade.exitPrice.toFixed(2),
        trade.pnl.toFixed(2),
        trade.pnlPercent.toFixed(1),
        trade.mae.toFixed(2),
        result,
        `"${trade.signalDetail.replace(/"/g, '""')}"` // Escape quotes in signal detail
      ];
      csvRows.push(row.join(','));
    });

    // Create CSV content
    const csvContent = csvRows.join('\n');

    // Create download link
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `backtest_${adjustedResults.strategy}_${adjustedResults.startDate}_to_${adjustedResults.endDate}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [adjustedResults]);

  return (
    <div className="backtesting">
      <div className="backtesting-header">
        <div className="header-title">
          <span className="header-label">STRATEGY BACKTESTING</span>
          <span className="header-subtitle">Test 5-minute pattern performance • {shareSize.toLocaleString()} shares per trade • Customizable entry times & exit strategies</span>
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

        <div className="control-group">
          <label htmlFor="share-size">Share Size:</label>
          <input
            id="share-size"
            type="number"
            min="1"
            step="100"
            value={shareSize}
            onChange={(e) => setShareSize(Math.max(1, parseInt(e.target.value) || 1))}
            disabled={isRunning}
            className="control-input"
          />
        </div>

        <div className="control-group">
          <label htmlFor="stop-loss-amount">Stop Loss ($):</label>
          <input
            id="stop-loss-amount"
            type="number"
            min="0"
            step="0.01"
            value={stopLossAmount || ''}
            onChange={(e) => {
              const value = parseFloat(e.target.value) || 0;
              setStopLossAmount(value);
              if (value > 0) setStopLossPercent(0); // Clear percent if amount is set
            }}
            placeholder="0.00"
            disabled={isRunning}
            className="control-input"
          />
        </div>

        <div className="control-group">
          <label htmlFor="stop-loss-percent">Stop Loss (%):</label>
          <input
            id="stop-loss-percent"
            type="number"
            min="0"
            step="0.1"
            value={stopLossPercent || ''}
            onChange={(e) => {
              const value = parseFloat(e.target.value) || 0;
              setStopLossPercent(value);
              if (value > 0) setStopLossAmount(0); // Clear amount if percent is set
            }}
            placeholder="0.0"
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

      {adjustedResults && (
        <div className="backtest-results">
          <div className="results-summary">
            <h3>Backtest Results</h3>
            <div className="summary-stats">
              <div className="stat-group">
                <div className="stat-item">
                  <span className="stat-label">Total Trades</span>
                  <span className="stat-value">{adjustedResults.totalTrades}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Breakeven</span>
                  <span className="stat-value breakeven">{adjustedResults.breakevenCount}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Total P&L</span>
                  <span className={`stat-value ${adjustedResults.totalPnL >= 0 ? 'positive' : 'negative'}`}>
                    ${adjustedResults.totalPnL.toFixed(2)}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Win Rate</span>
                  <span className="stat-value">{adjustedResults.winRate.toFixed(1)}%</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Profit Factor</span>
                  <span className="stat-value">{adjustedResults.profitFactor.toFixed(2)}</span>
                </div>
              </div>

              <div className="stat-group">
                <div className="stat-item">
                  <span className="stat-label">Avg Win</span>
                  <span className="stat-value positive">${adjustedResults.avgWin.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Avg Loss</span>
                  <span className="stat-value negative">${adjustedResults.avgLoss.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Max Win</span>
                  <span className="stat-value positive">${adjustedResults.maxWin.toFixed(2)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Max Loss</span>
                  <span className="stat-value negative">${adjustedResults.maxLoss.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Calendar View */}
          <div className="calendar-view">
            <h3>Daily P&L Calendar</h3>
            <div className="calendar-months">
              {calendarData.map((monthData, monthIdx) => (
                <div key={`${monthData.year}-${monthData.month}`} className="calendar-month">
                  <div className="calendar-month-header">{monthData.monthName}</div>
                  <div className="calendar-grid">
                    <div className="calendar-day-header">Sun</div>
                    <div className="calendar-day-header">Mon</div>
                    <div className="calendar-day-header">Tue</div>
                    <div className="calendar-day-header">Wed</div>
                    <div className="calendar-day-header">Thu</div>
                    <div className="calendar-day-header">Fri</div>
                    <div className="calendar-day-header">Sat</div>

                    {monthData.days.map((day, dayIdx) => (
                      <div
                        key={`${day.date}-${dayIdx}`}
                        className={`calendar-day ${
                          day.dayOfMonth === 0 ? 'empty' :
                          day.isWeekend ? 'weekend' :
                          day.hasData ? (day.pnl >= 0 ? 'profit' : 'loss') : 'no-data'
                        }`}
                        title={day.hasData ? `${day.date}\n${day.tradeCount} trade${day.tradeCount !== 1 ? 's' : ''}\nP&L: $${day.pnl.toFixed(2)}` : ''}
                      >
                        {day.dayOfMonth > 0 && (
                          <>
                            <span className="day-number">{day.dayOfMonth}</span>
                            {day.hasData && (
                              <div className="day-tooltip">
                                <div className="tooltip-date">{formatDate(day.date)}</div>
                                <div className="tooltip-trades">{day.tradeCount} trade{day.tradeCount !== 1 ? 's' : ''}</div>
                                <div className={`tooltip-pnl ${day.pnl >= 0 ? 'positive' : 'negative'}`}>
                                  ${day.pnl.toFixed(2)}
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="trades-table">
            <div className="trades-table-header">
              <h4>Trade Details</h4>
              <button className="download-csv-button" onClick={downloadCSV}>
                📥 Download CSV
              </button>
            </div>
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
                  {adjustedResults.trades.map((trade) => (
                    <tr key={trade.id} className={trade.isBreakeven ? 'breakeven-trade' : trade.isWin ? 'winning-trade' : 'losing-trade'}>
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
                      <td className={trade.isBreakeven ? 'breakeven' : trade.isWin ? 'positive' : 'negative'}>
                        ${trade.pnl.toFixed(2)}
                      </td>
                      <td className={trade.isBreakeven ? 'breakeven' : trade.isWin ? 'positive' : 'negative'}>
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