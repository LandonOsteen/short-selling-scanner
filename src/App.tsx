import React, { useState, useEffect, useCallback } from 'react';
import './App.css';
import ScannerWindow from './components/ScannerWindow';
import StatusBar from './components/StatusBar';
import UnifiedAlertFeed from './components/UnifiedAlertFeed';
import HistoricalTesting from './components/HistoricalTesting';
import Backtesting from './components/Backtesting';
import { PatternType, Alert } from './types';
import { GapScanner } from './services/GapScanner';

// Pattern configs for active scanners - G-Class styling
const PATTERN_CONFIGS: Record<PatternType, { title: string; color: string; priority: number }> = {
  'ToppingTail1m': { title: 'Topping Tail 1m', color: '#c9aa96', priority: 1 },
  'HODBreakCloseUnder': { title: 'HOD Break Close Under', color: '#e6d7c8', priority: 1 },
  'Run4PlusGreenThenRed': { title: '4+ Green Then Red', color: '#a08b7a', priority: 3 },
};

// Performance constants
const MAX_ALERTS_IN_MEMORY = 100; // Limit memory usage
const MAX_ALERTS_PER_PATTERN = 20;

function App() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [gapScanner] = useState(() => new GapScanner());
  const [stats, setStats] = useState({
    totalAlerts: 0,
    symbolsTracked: 0,
    lastUpdate: new Date().toLocaleTimeString()
  });
  const [layoutMode, setLayoutMode] = useState<'grid' | 'unified' | 'historical' | 'backtest'>('grid');
  const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(false);
  const [soundAlertsEnabled, setSoundAlertsEnabled] = useState(false);
  const [selectedSound, setSelectedSound] = useState('alert');

  // Enable/disable sound service when sound alerts toggle
  useEffect(() => {
    const enableSoundService = async () => {
      if (soundAlertsEnabled) {
        const { soundService } = await import('./services/SoundService');
        await soundService.enableAudio();
      }
    };
    enableSoundService();
  }, [soundAlertsEnabled]);

  // Real gap stock scanner with 6:00 AM - 9:30 AM ET timeframe
  useEffect(() => {
    const initializeScanner = async () => {
      try {
        console.log('Initializing Gap Scanner...');
        setIsInitializing(true);
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

        // Scanner initialization complete
        setIsInitializing(false);

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
        setIsInitializing(false);
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
  const handleLayoutModeChange = useCallback((mode: 'grid' | 'unified' | 'historical' | 'backtest') => {
    setLayoutMode(mode);
  }, []);


  // Keyboard navigation support
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case '1':
            e.preventDefault();
            handleLayoutModeChange('grid');
            break;
          case '2':
            e.preventDefault();
            handleLayoutModeChange('unified');
            break;
          case '3':
            e.preventDefault();
            handleLayoutModeChange('historical');
            break;
          case '4':
            e.preventDefault();
            handleLayoutModeChange('backtest');
            break;
          case 'v':
            e.preventDefault();
            setVoiceAlertsEnabled(prev => !prev);
            break;
        }
      }
    };

    document.addEventListener('keydown', handleKeyPress);
    return () => document.removeEventListener('keydown', handleKeyPress);
  }, [handleLayoutModeChange]);

  return (
    <div className="App">
      <div className="app-controls">
        <div className="layout-toggle" role="tablist" aria-label="Layout view options">
          <button
            className={`toggle-btn ${layoutMode === 'grid' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('grid')}
            role="tab"
            aria-selected={layoutMode === 'grid'}
            aria-controls="main-content"
            title="Switch to grid view (Ctrl+1)"
            disabled={isInitializing}
          >
            <span>GRID VIEW</span>
            {isInitializing && layoutMode === 'grid' && <span className="loading-dot" aria-hidden="true">●</span>}
          </button>
          <button
            className={`toggle-btn ${layoutMode === 'unified' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('unified')}
            role="tab"
            aria-selected={layoutMode === 'unified'}
            aria-controls="main-content"
            title="Switch to unified feed (Ctrl+2)"
            disabled={isInitializing}
          >
            <span>UNIFIED FEED</span>
            {isInitializing && layoutMode === 'unified' && <span className="loading-dot" aria-hidden="true">●</span>}
          </button>
          <button
            className={`toggle-btn ${layoutMode === 'historical' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('historical')}
            role="tab"
            aria-selected={layoutMode === 'historical'}
            aria-controls="main-content"
            title="Switch to historical testing (Ctrl+3)"
          >
            <span>HISTORICAL TEST</span>
          </button>
          <button
            className={`toggle-btn ${layoutMode === 'backtest' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('backtest')}
            role="tab"
            aria-selected={layoutMode === 'backtest'}
            aria-controls="main-content"
            title="Switch to backtesting (Ctrl+4)"
          >
            <span>BACKTEST</span>
          </button>
        </div>

        <div className="alerts-control-panel">
          <div className="alerts-toggles">
            <div className="alert-toggle-group">
              <label className="alert-toggle-label" title="Toggle voice alerts (Ctrl+V)">
                <input
                  type="checkbox"
                  checked={voiceAlertsEnabled}
                  onChange={(e) => setVoiceAlertsEnabled(e.target.checked)}
                />
                <span className="alert-toggle-text">VOICE</span>
                <span className={`alert-status ${voiceAlertsEnabled ? 'on' : 'off'}`}>
                  {voiceAlertsEnabled ? 'ON' : 'OFF'}
                </span>
              </label>
            </div>

            <div className="alert-toggle-group">
              <label className="alert-toggle-label" title="Toggle sound alerts">
                <input
                  type="checkbox"
                  checked={soundAlertsEnabled}
                  onChange={(e) => setSoundAlertsEnabled(e.target.checked)}
                />
                <span className="alert-toggle-text">SOUND</span>
                <span className={`alert-status ${soundAlertsEnabled ? 'on' : 'off'}`}>
                  {soundAlertsEnabled ? 'ON' : 'OFF'}
                </span>
              </label>
            </div>
          </div>

          {soundAlertsEnabled && (
            <div className="sound-controls">
              <select
                value={selectedSound}
                onChange={(e) => setSelectedSound(e.target.value)}
                className="sound-select"
                title="Select alert sound"
              >
                <option value="beep">Classic Beep</option>
                <option value="chime">Gentle Chime</option>
                <option value="alert">Alert Tone</option>
                <option value="urgent">Urgent Alert</option>
                <option value="trading-bell">Trading Bell</option>
                <option value="success">Success Tone</option>
                <option value="warning">Warning Sound</option>
              </select>
              <button
                className="sound-preview-btn"
                onClick={() => {
                  // Import and use sound service for preview
                  import('./services/SoundService').then(({ soundService }) => {
                    soundService.previewSound(selectedSound);
                  });
                }}
                title="Preview selected sound"
              >
                🎵
              </button>
            </div>
          )}
        </div>
      </div>

      <main id="main-content" role="main" aria-label={`${layoutMode} view`}>
        {layoutMode === 'grid' ? (
          <div className="scanner-grid" role="grid" aria-label="Pattern scanner windows">
            {isInitializing && (
              <div className="loading-overlay" aria-live="polite">
                <span className="loading-text">INITIALIZING SCANNER...</span>
              </div>
            )}
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
            soundAlertsEnabled={soundAlertsEnabled}
            selectedSound={selectedSound}
            isConnected={isConnected}
            stats={stats}
            symbols={symbols}
          />
        </div>
      ) : layoutMode === 'historical' ? (
        <div className="historical-layout">
          <HistoricalTesting
            gapScanner={gapScanner}
          />
        </div>
      ) : (
        <div className="backtest-layout">
          <Backtesting
            gapScanner={gapScanner}
          />
        </div>
        )}
      </main>

      {layoutMode !== 'unified' && layoutMode !== 'backtest' && (
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
