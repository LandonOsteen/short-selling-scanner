import React, { useState, useEffect, useCallback } from 'react';
import './App.css';
import HODBreakFeed from './components/HODBreakFeed';
import HistoricalTesting from './components/HistoricalTesting';
import Backtesting from './components/Backtesting';
import { Alert } from './types';
import { GapScanner } from './services/GapScanner';
import { getScannerConfig } from './config/scannerConfig';
import { soundService } from './services/SoundService';

// Performance constants
const MAX_ALERTS_IN_MEMORY = 100; // Limit memory usage

function App() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [gapScanner] = useState(() => new GapScanner(undefined, getScannerConfig()));
  const [stats, setStats] = useState({
    totalAlerts: 0,
    symbolsTracked: 0,
    lastUpdate: new Date().toLocaleTimeString()
  });
  const [layoutMode, setLayoutMode] = useState<'hodbreak' | 'historical' | 'backtest'>('hodbreak');
  const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(false);
  const [soundAlertsEnabled, setSoundAlertsEnabled] = useState(false);
  const [selectedSound, setSelectedSound] = useState('alert');

  // Enable/disable sound service when sound alerts toggle
  useEffect(() => {
    const enableSoundService = async () => {
      if (soundAlertsEnabled) {
        await soundService.enableAudio();
      } else {
        soundService.disableAudio();
      }
    };
    enableSoundService();
  }, [soundAlertsEnabled]);

  // Real gap stock scanner with configurable timeframe
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    const initializeScanner = async () => {
      try {
        console.log('Initializing Gap Scanner...');
        setIsConnected(true);

        // Set up alert callback FIRST (before any scanning starts)
        unsubscribe = gapScanner.onAlert((alert: Alert) => {
          console.log(`🔔 New alert: ${alert.symbol} ${alert.type} at ${new Date(alert.timestamp).toLocaleTimeString()}`);

          setAlerts(prev => {
            // Check for duplicate
            const isDuplicate = prev.some(a => a.id === alert.id);
            if (isDuplicate) {
              console.log(`   ⏭️  Skipping duplicate: ${alert.id}`);
              return prev;
            }

            const newAlerts = [...prev, alert];
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

        // Backfill historical data if accessing after configured start time
        console.log('Backfilling historical data...');
        try {
          const backfilledAlerts = await gapScanner.backfillMissedData();
          if (backfilledAlerts.length > 0) {
            // Fire initial alerts through the callback system for consistency
            console.log(`📊 Loading ${backfilledAlerts.length} historical alerts through callback system...`);
            backfilledAlerts.forEach(alert => {
              // Fire through the alert system to ensure deduplication and sound alerts
              gapScanner.fireAlert(alert);
            });
          }

          // Set the baseline time for continuous scanning
          // This ensures future scans only look for NEW alerts after this point
          gapScanner.setLastBackfillTime(Date.now());
        } catch (error) {
          console.warn('Backfill failed:', error);
        }

        // Initial load of qualified gap stocks
        const gapStocks = await gapScanner.scanForGappers();
        const gapSymbols = gapStocks.map(stock => stock.symbol);
        setSymbols(gapSymbols);

        setStats(prev => ({
          ...prev,
          symbolsTracked: gapSymbols.length,
          lastUpdate: new Date().toLocaleTimeString()
        }));

        console.log(`Tracking ${gapSymbols.length} gap stocks: ${gapSymbols.join(', ')}`);

        // Start continuous scanning
        console.log('Starting continuous gap scanner...');
        try {
          await gapScanner.startScanning();
          console.log('✅ Scanner started successfully');
        } catch (error) {
          console.warn('Scanner start failed:', error);
        }

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
      console.log('🧹 Cleaning up scanner...');
      clearInterval(symbolUpdateInterval);
      clearTimeout(updateTimeout);
      if (unsubscribe) unsubscribe(); // Remove alert callback
      gapScanner.stopScanning();
    };
  }, [gapScanner]);

  // Memoize event handlers to prevent child re-renders
  const handleLayoutModeChange = useCallback((mode: 'hodbreak' | 'historical' | 'backtest') => {
    setLayoutMode(mode);
  }, []);


  // Keyboard navigation support
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case '1':
            e.preventDefault();
            handleLayoutModeChange('hodbreak');
            break;
          case '2':
            e.preventDefault();
            handleLayoutModeChange('historical');
            break;
          case '3':
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
            className={`toggle-btn ${layoutMode === 'hodbreak' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('hodbreak')}
            role="tab"
            aria-selected={layoutMode === 'hodbreak'}
            aria-controls="main-content"
            title="Switch to Live Scanner feed (Ctrl+1)"
          >
            <span>LIVE SCANNER</span>
          </button>
          <button
            className={`toggle-btn ${layoutMode === 'historical' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('historical')}
            role="tab"
            aria-selected={layoutMode === 'historical'}
            aria-controls="main-content"
            title="Switch to historical testing (Ctrl+2)"
          >
            <span>HISTORICAL TEST</span>
          </button>
          <button
            className={`toggle-btn ${layoutMode === 'backtest' ? 'active' : ''}`}
            onClick={() => handleLayoutModeChange('backtest')}
            role="tab"
            aria-selected={layoutMode === 'backtest'}
            aria-controls="main-content"
            title="Switch to backtesting (Ctrl+3)"
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
                  soundService.previewSound(selectedSound);
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
        {layoutMode === 'hodbreak' ? (
          <div className="hodbreak-layout">
            <HODBreakFeed
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

    </div>
  );
}

export default App;
