import React, { useState, useCallback, memo } from 'react';
import './HistoricalTesting.css';
import { Alert, PatternType } from '../types';
import { GapScanner } from '../services/GapScanner';

interface HistoricalTestingProps {
  gapScanner: GapScanner;
}

interface HistoricalResults {
  date: string;
  alerts: Alert[];
  totalAlerts: number;
  patternBreakdown: Record<PatternType, number>;
  symbolsScanned: string[];
  scanDuration: number;
}

const PATTERN_CONFIGS: Record<PatternType, { title: string; color: string; priority: number }> = {
  'ToppingTail1m': { title: 'Topping Tail 1m', color: '#c9aa96', priority: 1 },
  'HODBreakCloseUnder': { title: 'HOD Break Close Under', color: '#e6d7c8', priority: 1 },
  'Run4PlusGreenThenRed': { title: '4+ Green Then Red', color: '#a08b7a', priority: 3 },
};

const HistoricalTesting: React.FC<HistoricalTestingProps> = ({ gapScanner }) => {
  const [selectedDate, setSelectedDate] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [results, setResults] = useState<HistoricalResults | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      // Calculate pattern breakdown
      const patternBreakdown: Record<PatternType, number> = {
        'ToppingTail1m': 0,
        'HODBreakCloseUnder': 0,
        'Run4PlusGreenThenRed': 0,
      };

      const uniqueSymbols = new Set<string>();

      historicalAlerts.forEach(alert => {
        patternBreakdown[alert.type]++;
        uniqueSymbols.add(alert.symbol);
      });

      const scanDuration = Date.now() - startTime;

      setResults({
        date: selectedDate,
        alerts: historicalAlerts,
        totalAlerts: historicalAlerts.length,
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

  return (
    <div className="historical-testing">
      <div className="historical-header">
        <div className="header-title">
          <span className="header-label">HISTORICAL PATTERN TESTING</span>
          <span className="header-subtitle">Scan pre-market signals for any past date</span>
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
              <span className="total-alerts">{results.totalAlerts} ALERTS</span>
              <span className="symbols-count">{results.symbolsScanned.length} SYMBOLS</span>
              <span className="scan-time">{(results.scanDuration / 1000).toFixed(1)}s</span>
            </div>
          </div>

          <div className="pattern-breakdown">
            <h4>Pattern Breakdown</h4>
            <div className="pattern-grid">
              {Object.entries(PATTERN_CONFIGS).map(([pattern, config]) => {
                const count = results.patternBreakdown[pattern as PatternType];
                return (
                  <div
                    key={pattern}
                    className={`pattern-stat priority-${config.priority}`}
                    style={{ borderLeftColor: config.color }}
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
            <h4>Alert Timeline</h4>
            <div className="timeline-container">
              {results.alerts.length === 0 ? (
                <div className="no-alerts-historical">
                  <div className="no-alerts-main">NO PATTERNS DETECTED</div>
                  <div className="no-alerts-sub">No qualifying signals found for this date</div>
                </div>
              ) : (
                results.alerts
                  .sort((a, b) => a.timestamp - b.timestamp)
                  .map((alert) => {
                    const config = PATTERN_CONFIGS[alert.type];
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