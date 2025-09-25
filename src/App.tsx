import React, { useState, useEffect, useCallback } from 'react';
import './App.css';
import ScannerWindow from './components/ScannerWindow';
import StatusBar from './components/StatusBar';
import UnifiedAlertFeed from './components/UnifiedAlertFeed';
import HistoricalTesting from './components/HistoricalTesting';
import { PatternType, Alert } from './types';
import { GapScanner } from './services/GapScanner';

// Simplified pattern configs - minimal blessed-like styling
const PATTERN_CONFIGS: Record<PatternType, { title: string; color: string; priority: number }> = {
  'ToppingTail1m': { title: 'Topping Tail 1m', color: '#ffff00', priority: 1 },
  'ToppingTail5m': { title: 'Topping Tail 5m', color: '#ffff00', priority: 1 },
  'HODBreakCloseUnder': { title: 'HOD Break Close Under', color: '#ffff00', priority: 1 },
  'New1mLowNearHOD': { title: 'New 1m Low Near HOD', color: '#00ffff', priority: 2 },
  'EMA200Reject': { title: 'EMA200 Reject', color: '#00ffff', priority: 2 },
  'DoubleTop': { title: 'Double Top', color: '#ff00ff', priority: 3 },
  'TripleTop': { title: 'Triple Top', color: '#ff00ff', priority: 3 },
  'Run4PlusGreenThenRed': { title: '4+ Green Then Red', color: '#ff00ff', priority: 3 },
};

// Performance constants
const MAX_ALERTS_IN_MEMORY = 100; // Limit memory usage
const MAX_ALERTS_PER_PATTERN = 20;

function App() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [gapScanner] = useState(() => new GapScanner());
  const [stats, setStats] = useState({
    totalAlerts: 0,
    symbolsTracked: 0,
    lastUpdate: new Date().toLocaleTimeString()
  });
  const [layoutMode, setLayoutMode] = useState<'grid' | 'unified' | 'historical'>('grid');
  const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(false);

  // Real gap stock scanner with 6:00 AM - 9:30 AM ET timeframe
  useEffect(() => {
    const initializeScanner = async () => {
      try {
        console.log('Initializing Gap Scanner...');
        setIsConnected(true);

        console.log('Scanner initialization starting...');

        // Backfill historical data if accessing after 6:00 AM
        console.log('Backfilling historical data...');
        let backfilledAlerts: Alert[] = [];
        try {
          backfilledAlerts = await gapScanner.backfillMissedData();
          if (backfilledAlerts.length > 0) {
            setAlerts(backfilledAlerts);
            console.log(`Loaded ${backfilledAlerts.length} historical alerts`);
          }
        } catch (error) {
          console.warn('Backfill failed:', error);
        }

        // Start scanning for current gap stocks
        console.log('Starting gap scanner...');
        try {
          gapScanner.startScanning();
        } catch (error) {
          console.warn('Scanner start failed:', error);
        }

        // Initial load of qualified gap stocks
        const gapStocks = await gapScanner.scanForGappers();
        const gapSymbols = gapStocks.map(stock => stock.symbol);
        setSymbols(gapSymbols);

        setStats({
          totalAlerts: backfilledAlerts.length,
          symbolsTracked: gapSymbols.length,
          lastUpdate: new Date().toLocaleTimeString()
        });

        console.log(`Tracking ${gapSymbols.length} gap stocks: ${gapSymbols.join(', ')}`);

        // Set up alert callback with pagination
        gapScanner.onAlert((alert: Alert) => {
          setAlerts(prev => {
            const newAlerts = [...prev, alert];
            // Keep only the most recent alerts to prevent memory issues
            return newAlerts.length > MAX_ALERTS_IN_MEMORY
              ? newAlerts.slice(-MAX_ALERTS_IN_MEMORY)
              : newAlerts;
          });
          setStats(prev => ({
            ...prev,
            totalAlerts: prev.totalAlerts + 1,
            lastUpdate: new Date().toLocaleTimeString()
          }));
        });

      } catch (error) {
        console.error('Failed to initialize scanner:', error);
        console.error('Error details:', error);
        setIsConnected(false);
      }
    };

    initializeScanner();

    // Debounced symbol update function
    let updateTimeout: NodeJS.Timeout;
    const debouncedUpdateSymbols = () => {
      clearTimeout(updateTimeout);
      updateTimeout = setTimeout(async () => {
        try {
          const gapStocks = await gapScanner.scanForGappers();
          const gapSymbols = gapStocks.map(stock => stock.symbol);

          // Only update if symbols actually changed
          setSymbols(prevSymbols => {
            const hasChanged = prevSymbols.length !== gapSymbols.length ||
              prevSymbols.some((symbol, index) => symbol !== gapSymbols[index]);
            return hasChanged ? gapSymbols : prevSymbols;
          });

          setStats(prev => ({
            ...prev,
            symbolsTracked: gapSymbols.length,
            lastUpdate: new Date().toLocaleTimeString()
          }));
        } catch (error) {
          console.error('Failed to update symbols:', error);
        }
      }, 1000); // 1 second debounce
    };

    // Update symbols every 2 minutes with debouncing
    const symbolUpdateInterval = setInterval(debouncedUpdateSymbols, 120000);

    // Cleanup
    return () => {
      clearInterval(symbolUpdateInterval);
      clearTimeout(updateTimeout);
      gapScanner.stopScanning();
    };
  }, [gapScanner]);

  // Memoize expensive pattern filtering and sorting
  const getAlertsForPattern = useCallback((pattern: PatternType): Alert[] => {
    return alerts.filter(alert => alert.type === pattern)
                 .sort((a, b) => b.timestamp - a.timestamp)
                 .slice(0, MAX_ALERTS_PER_PATTERN);
  }, [alerts]);

  // Memoize event handlers to prevent child re-renders
  const handleLayoutModeChange = useCallback((mode: 'grid' | 'unified' | 'historical') => {
    setLayoutMode(mode);
  }, []);

  const handleVoiceAlertsChange = useCallback((enabled: boolean) => {
    setVoiceAlertsEnabled(enabled);
  }, []);

  return (
    <div className="App">
      <div className="app-controls">
        <div className="layout-toggle">
          <button
            className={`toggle-btn ${layoutMode === 'grid' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('grid')}
          >
            GRID VIEW
          </button>
          <button
            className={`toggle-btn ${layoutMode === 'unified' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('unified')}
          >
            UNIFIED FEED
          </button>
          <button
            className={`toggle-btn ${layoutMode === 'historical' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('historical')}
          >
            HISTORICAL TEST
          </button>
        </div>

        <div className="voice-toggle">
          <label className="voice-toggle-label">
            <input
              type="checkbox"
              checked={voiceAlertsEnabled}
              onChange={(e) => handleVoiceAlertsChange(e.target.checked)}
            />
            <span className="voice-toggle-text">
              VOICE ALERTS
            </span>
            <span className={`voice-status ${voiceAlertsEnabled ? 'on' : 'off'}`}>
              {voiceAlertsEnabled ? 'ON' : 'OFF'}
            </span>
          </label>
        </div>
      </div>

      {layoutMode === 'grid' ? (
        <div className="scanner-grid">
          {Object.entries(PATTERN_CONFIGS).map(([pattern, config]) => (
            <ScannerWindow
              key={pattern}
              title={config.title}
              color={config.color}
              priority={config.priority}
              alerts={getAlertsForPattern(pattern as PatternType)}
              pattern={pattern as PatternType}
            />
          ))}
        </div>
      ) : layoutMode === 'unified' ? (
        <div className="unified-layout">
          <UnifiedAlertFeed
            alerts={alerts}
            voiceAlertsEnabled={voiceAlertsEnabled}
            isConnected={isConnected}
            stats={stats}
            symbols={symbols}
          />
        </div>
      ) : (
        <div className="historical-layout">
          <HistoricalTesting
            gapScanner={gapScanner}
          />
        </div>
      )}

      {layoutMode !== 'unified' && (
        <StatusBar
          isConnected={isConnected}
          stats={stats}
          symbols={symbols}
        />
      )}
    </div>
  );
}

export default App;
