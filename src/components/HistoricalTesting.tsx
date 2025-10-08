import React, { useState, useCallback, memo, useMemo } from 'react';
import './HistoricalTesting.css';
import { Alert, PatternType } from '../types';
import { GapScanner } from '../services/GapScanner';
import { getScannerConfig } from '../config/scannerConfig';

interface HistoricalTestingProps {
  gapScanner: GapScanner;
}

interface HistoricalResults {
  date: string;
  alerts: Alert[];
  totalAlerts: number;
  patternBreakdown: Partial<Record<PatternType, number>>;
  symbolsScanned: string[];
  scanDuration: number;
}

const PATTERN_CONFIGS: Partial<Record<PatternType, { title: string; color: string; priority: number }>> = {
  'ToppingTail5m': { title: '5-Minute Topping Tail', color: '#dc3545', priority: 1 },
  'GreenRunReject': { title: 'Green Run Rejection', color: '#28a745', priority: 1 },
};

const HistoricalTesting: React.FC<HistoricalTestingProps> = ({ gapScanner }) => {
  const [selectedDate, setSelectedDate] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [results, setResults] = useState<HistoricalResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [patternFilter, setPatternFilter] = useState<PatternType | 'all'>('all');

  // Time filtering
  const [filterStartTime, setFilterStartTime] = useState('06:30');
  const [filterEndTime, setFilterEndTime] = useState('10:00');

  // Get scanner config for display
  const config = useMemo(() => getScannerConfig(), []);

  const formatDate = useCallback((dateString: string): string => {
    // Parse date string safely to avoid timezone issues
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day); // month is 0-indexed
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }, []);

  const formatTime = useCallback((timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }, []);

  const handleDateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedDate(e.target.value);
    setError(null);
  }, []);

  const runHistoricalScan = useCallback(async () => {
    if (!selectedDate) {
      setError('Please select a date');
      return;
    }

    // Parse selected date safely to avoid timezone issues
    const [year, month, day] = selectedDate.split('-').map(Number);
    const selectedDateObj = new Date(year, month - 1, day); // month is 0-indexed
    const today = new Date();

    if (selectedDateObj >= today) {
      setError('Please select a date in the past');
      return;
    }

    if (selectedDateObj.getDay() === 0 || selectedDateObj.getDay() === 6) {
      setError('Please select a weekday (markets are closed on weekends)');
      return;
    }

    setIsScanning(true);
    setError(null);
    setResults(null);

    const startTime = Date.now();

    try {
      console.log(`Starting historical scan for ${selectedDate}...`);

      // Get historical alerts for the selected date
      const historicalAlerts = await gapScanner.getHistoricalAlertsForDate(selectedDate);

      // Calculate pattern breakdown (only for 5-minute patterns)
      const patternBreakdown: Partial<Record<PatternType, number>> = {
        'ToppingTail5m': 0,
        'GreenRunReject': 0,
      };

      const uniqueSymbols = new Set<string>();

      // Filter to only include 5-minute patterns we care about
      const filteredHistoricalAlerts = historicalAlerts.filter(
        alert => alert.type === 'ToppingTail5m' || alert.type === 'GreenRunReject'
      );

      filteredHistoricalAlerts.forEach(alert => {
        if (alert.type in patternBreakdown) {
          patternBreakdown[alert.type] = (patternBreakdown[alert.type] || 0) + 1;
        }
        uniqueSymbols.add(alert.symbol);
      });

      const scanDuration = Date.now() - startTime;

      setResults({
        date: selectedDate,
        alerts: filteredHistoricalAlerts,
        totalAlerts: filteredHistoricalAlerts.length,
        patternBreakdown,
        symbolsScanned: Array.from(uniqueSymbols),
        scanDuration
      });

    } catch (error) {
      console.error('Historical scan failed:', error);
      setError(`Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsScanning(false);
    }
  }, [selectedDate, gapScanner]);

  // Filter alerts by pattern type AND time range
  const filteredAlerts = useMemo(() => {
    if (!results) return [];

    // Parse filter times
    const [startHour, startMin] = filterStartTime.split(':').map(Number);
    const [endHour, endMin] = filterEndTime.split(':').map(Number);
    const filterStart = startHour + startMin / 60;
    const filterEnd = endHour + endMin / 60;

    let filtered = results.alerts;

    // Filter by pattern type
    if (patternFilter !== 'all') {
      filtered = filtered.filter(alert => alert.type === patternFilter);
    }

    // Filter by time range
    filtered = filtered.filter(alert => {
      const alertTime = new Date(alert.timestamp);
      const etTime = new Date(alertTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
      const etHour = etTime.getHours() + etTime.getMinutes() / 60;
      return etHour >= filterStart && etHour < filterEnd;
    });

    return filtered;
  }, [results, patternFilter, filterStartTime, filterEndTime]);

  return (
    <div className="historical-testing">
      <div className="historical-header">
        <div className="header-title">
          <span className="header-label">HISTORICAL PATTERN TESTING</span>
          <span className="header-subtitle">Scan for 5-minute patterns during regular market hours</span>
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

      <div className="scan-controls">
        <div className="date-input-group">
          <label htmlFor="historical-date">Select Date:</label>
          <input
            id="historical-date"
            type="date"
            value={selectedDate}
            onChange={handleDateChange}
            max={new Date().toISOString().split('T')[0]}
            disabled={isScanning}
          />
        </div>

        <div className="date-input-group">
          <label htmlFor="filter-start-time">Filter Start:</label>
          <input
            id="filter-start-time"
            type="time"
            value={filterStartTime}
            onChange={(e) => setFilterStartTime(e.target.value)}
            disabled={isScanning}
          />
        </div>

        <div className="date-input-group">
          <label htmlFor="filter-end-time">Filter End:</label>
          <input
            id="filter-end-time"
            type="time"
            value={filterEndTime}
            onChange={(e) => setFilterEndTime(e.target.value)}
            disabled={isScanning}
          />
        </div>

        <button
          className={`scan-button ${isScanning ? 'scanning' : ''}`}
          onClick={runHistoricalScan}
          disabled={isScanning || !selectedDate}
        >
          {isScanning ? 'SCANNING...' : 'RUN HISTORICAL SCAN'}
        </button>
      </div>

      {error && (
        <div className="error-message">
          <span className="error-icon">⚠</span>
          <span className="error-text">{error}</span>
        </div>
      )}

      {isScanning && (
        <div className="scanning-indicator">
          <div className="scanning-spinner"></div>
          <span>Analyzing historical data for {formatDate(selectedDate)}...</span>
        </div>
      )}

      {results && (
        <div className="results-container">
          <div className="results-header">
            <h3>Results for {formatDate(results.date)}</h3>
            <div className="results-summary">
              <span className="total-alerts">{results.totalAlerts} TOTAL</span>
              <span className="filtered-alerts">{filteredAlerts.length} SHOWING</span>
              <span className="symbols-count">{results.symbolsScanned.length} SYMBOLS</span>
              <span className="scan-time">{(results.scanDuration / 1000).toFixed(1)}s</span>
            </div>
          </div>

          <div className="pattern-breakdown">
            <h4>Pattern Breakdown</h4>
            <div className="pattern-filter-group">
              <label htmlFor="pattern-filter">Filter by Pattern:</label>
              <select
                id="pattern-filter"
                value={patternFilter}
                onChange={(e) => setPatternFilter(e.target.value as PatternType | 'all')}
                className="pattern-filter-select"
              >
                <option value="all">All Patterns ({results.totalAlerts})</option>
                {Object.entries(PATTERN_CONFIGS).map(([pattern, config]) => {
                  const count = results.patternBreakdown[pattern as PatternType] || 0;
                  return (
                    <option key={pattern} value={pattern}>
                      {config.title} ({count})
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="pattern-grid">
              {Object.entries(PATTERN_CONFIGS).map(([pattern, config]) => {
                const count = results.patternBreakdown[pattern as PatternType] || 0;
                const isSelected = patternFilter === pattern || patternFilter === 'all';
                return (
                  <div
                    key={pattern}
                    className={`pattern-stat priority-${config.priority} ${isSelected ? 'selected' : 'dimmed'}`}
                    style={{ borderLeftColor: config.color }}
                    onClick={() => setPatternFilter(patternFilter === pattern ? 'all' : pattern as PatternType)}
                  >
                    <div className="pattern-name" style={{ color: config.color }}>
                      {config.title}
                    </div>
                    <div className="pattern-count">{count}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="alerts-timeline">
            <h4>Alert Timeline {patternFilter !== 'all' && PATTERN_CONFIGS[patternFilter] && `(${PATTERN_CONFIGS[patternFilter]!.title})`}</h4>
            <div className="timeline-container">
              {filteredAlerts.length === 0 ? (
                <div className="no-alerts-historical">
                  <div className="no-alerts-main">NO PATTERNS DETECTED</div>
                  <div className="no-alerts-sub">
                    {results.alerts.length === 0
                      ? 'No qualifying signals found for this date'
                      : 'No signals match the selected filter'}
                  </div>
                </div>
              ) : (
                filteredAlerts
                  .sort((a, b) => a.timestamp - b.timestamp)
                  .filter((alert) => PATTERN_CONFIGS[alert.type]) // Only show alerts for patterns we support
                  .map((alert) => {
                    const config = PATTERN_CONFIGS[alert.type]!; // Non-null assertion safe due to filter above
                    return (
                      <div
                        key={alert.id}
                        className={`timeline-alert priority-${config.priority}`}
                        style={{ borderLeftColor: config.color }}
                      >
                        <div className="alert-time">{formatTime(alert.timestamp)}</div>
                        <div className="alert-content">
                          <div className="alert-symbol-pattern">
                            <span className="alert-symbol">{alert.symbol}</span>
                            <span className="alert-pattern" style={{ color: config.color }}>
                              {config.title}
                            </span>
                          </div>
                          <div className="alert-details">
                            <span className="alert-price">${alert.price.toFixed(2)}</span>
                            <span className="alert-volume">{(alert.volume / 1000).toFixed(0)}k vol</span>
                            {alert.gapPercent && (
                              <span className="alert-gap">{alert.gapPercent.toFixed(1)}% gap</span>
                            )}
                          </div>
                        </div>
                        <div className="alert-description">{alert.detail}</div>
                      </div>
                    );
                  })
              )}
            </div>
          </div>

          <div className="symbols-scanned">
            <h4>Symbols Analyzed</h4>
            <div className="symbols-list">
              {results.symbolsScanned.map((symbol, index) => (
                <span key={symbol} className="symbol-tag">
                  {symbol}
                  {index < results.symbolsScanned.length - 1 && ', '}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(HistoricalTesting);