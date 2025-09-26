// Gap Scanner Service - Real gap stock detection with volume criteria
import { Alert, PatternType, SymbolData } from '../types';
import { getScannerConfig, validateScannerConfig, ScannerConfig } from '../config/scannerConfig';

export interface GapStock {
  symbol: string;
  gapPercent: number;
  currentPrice: number;
  previousClose: number;
  volume: number;
  cumulativeVolume: number;
  hod: number;
  lastUpdated: number;
  ema200?: number; // Daily 200 EMA - calculated once per day
}

export interface PolygonBar {
  t: number; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
  T?: string; // ticker symbol (present in grouped daily data)
}

export interface PolygonAggregatesResponse {
  results: PolygonBar[];
  status: string;
  request_id: string;
  count: number;
}

export interface PolygonGainerResult {
  ticker: string;
  value: number;
  change_percentage: number;
}

export interface PolygonGainersResponse {
  results: PolygonGainerResult[];
  status: string;
}

export interface PolygonPreviousCloseResult {
  T: string; // ticker
  c: number; // close
  h: number; // high
  l: number; // low
  o: number; // open
  v: number; // volume
}

export interface PolygonPreviousCloseResponse {
  results: PolygonPreviousCloseResult[];
  status: string;
}

export class GapScanner {
  private polygonApiKey: string;
  private gapStocks: Map<string, GapStock> = new Map();
  private isScanning: boolean = false;
  private scanInterval: number | null = null;
  private alertCallbacks: ((alert: Alert) => void)[] = [];
  private firedAlertIds: Set<string> = new Set();
  private lastBackfillTime: number = 0;
  private config: ScannerConfig;

  // Pattern state tracking to persist across scans - CRITICAL FIX
  private patternStates = new Map<string, {
    hod: number;
    consecutiveGreenCandles: number;
    lastBarWasGreen: boolean;
    greenRunStartPrice?: number;
    lastAnalyzedBarTimestamp: number;
  }>();

  // Performance optimizations
  private requestCache: Map<string, { data: any; timestamp: number }> = new Map();
  private requestQueue: Map<string, Promise<any>> = new Map();
  private maxRetries: number = 3;
  private cacheTimeout: number = 30000; // 30 seconds

  constructor(apiKey?: string, config?: ScannerConfig) {
    this.polygonApiKey = apiKey || process.env.REACT_APP_POLYGON_API_KEY || '';
    this.config = config || getScannerConfig();

    // Validate configuration on startup
    this.validateAndApplyConfig();
  }

  // Validate and apply configuration
  private validateAndApplyConfig(): void {
    const configErrors = validateScannerConfig(this.config);
    if (configErrors.length > 0) {
      console.error('Scanner Configuration Errors:', configErrors);
      throw new Error(`Invalid scanner configuration: ${configErrors.join(', ')}`);
    }

    // Update performance settings from config
    this.maxRetries = this.config.api.maxRetries;
    this.cacheTimeout = this.config.api.requestTimeout;

    if (this.config.development.enableDebugLogging) {
      console.log('🔧 Scanner Configuration Applied:', {
        marketHours: `${this.config.marketHours.startTime} - ${this.config.marketHours.endTime} (${this.config.marketHours.timezone})`,
        gapCriteria: `${this.config.gapCriteria.minGapPercentage}%-${this.config.gapCriteria.maxGapPercentage}%, $${this.config.gapCriteria.minPrice}-$${this.config.gapCriteria.maxPrice}, vol: ${this.config.gapCriteria.minCumulativeVolume}`,
        hodSettings: `Near HOD: ${this.config.patterns.hod.nearHodDistancePercent}%, Max: ${this.config.patterns.hod.maxHodDistancePercent}%`
      });
    }
  }

  // Update configuration at runtime
  public updateConfig(newConfig: Partial<ScannerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.validateAndApplyConfig();

    if (this.config.development.enableDebugLogging) {
      console.log('🔄 Configuration updated successfully');
    }
  }

  // Get current time (supports override for testing)
  private getCurrentTime(): Date {
    if (this.config.development.overrideCurrentTime) {
      return new Date(this.config.development.overrideCurrentTime);
    }
    return new Date();
  }

  // Check if current time is within configured market hours
  private isWithinMarketHours(now?: Date): boolean {
    const currentTime = now || this.getCurrentTime();
    const etHour = this.getETHour(currentTime);
    const etMinutes = this.getETMinutes(currentTime);

    const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);
    const [endHour, endMin] = this.config.marketHours.endTime.split(':').map(Number);

    const startTimeInMinutes = startHour * 60 + startMin;
    const endTimeInMinutes = endHour * 60 + endMin;
    const currentTimeInMinutes = etHour * 60 + etMinutes;

    return currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes < endTimeInMinutes;
  }

  // Helper to get ET minutes
  private getETMinutes(date: Date): number {
    const etDate = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
    return etDate.getMinutes();
  }

  // Optimized fetch with caching and request deduplication
  private async cachedFetch(url: string, options?: RequestInit): Promise<any> {
    const cacheKey = `${url}-${JSON.stringify(options)}`;

    // Check cache first
    const cached = this.requestCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    // Check if request is already in progress
    const existingRequest = this.requestQueue.get(cacheKey);
    if (existingRequest) {
      return existingRequest;
    }

    // Make new request with retry logic
    const request = this.fetchWithRetry(url, options, this.maxRetries);
    this.requestQueue.set(cacheKey, request);

    try {
      const data = await request;

      // Cache the result
      this.requestCache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });

      return data;
    } finally {
      // Clean up request queue
      this.requestQueue.delete(cacheKey);
    }
  }

  // Fetch with exponential backoff retry
  private async fetchWithRetry(url: string, options?: RequestInit, maxRetries: number = 3): Promise<any> {
    let lastError: Error = new Error('Unknown error occurred');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          timeout: this.config.api.httpTimeout,
        } as any);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
      } catch (error) {
        lastError = error as Error;

        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.warn(`Request failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  // Scan for gap stocks using configurable criteria
  async scanForGappers(): Promise<GapStock[]> {
    try {
      const now = this.getCurrentTime();
      const etHour = this.getETHour(now);

      if (this.config.development.enableDebugLogging) {
        console.log(`Scanning for gappers at ET time: ${this.formatETTime(now)} (${etHour.toFixed(2)})`);
      }

      // Always fetch real gap stocks from API when available
      // This ensures consistent data regardless of login time
      const gappers = await this.fetchGappersFromAPI();

      // Filter based on configured criteria
      const filteredGappers = gappers.filter(stock =>
        stock.gapPercent >= this.config.gapCriteria.minGapPercentage &&
        stock.gapPercent <= this.config.gapCriteria.maxGapPercentage &&
        stock.cumulativeVolume >= this.config.gapCriteria.minCumulativeVolume &&
        stock.currentPrice >= this.config.gapCriteria.minPrice &&
        stock.currentPrice <= this.config.gapCriteria.maxPrice
      );

      // Update our gap stocks map
      filteredGappers.forEach(stock => {
        this.gapStocks.set(stock.symbol, stock);
      });

      if (this.config.development.enableDebugLogging) {
        console.log(`Found ${filteredGappers.length} qualified gap stocks (min gap: ${this.config.gapCriteria.minGapPercentage}%, min vol: ${this.config.gapCriteria.minCumulativeVolume})`);

        // Debug: Log each qualified stock with its volume
        filteredGappers.forEach(stock => {
          console.log(`✅ QUALIFIED STOCK: ${stock.symbol} - ${(stock.cumulativeVolume / 1000).toFixed(0)}k volume (${stock.gapPercent.toFixed(1)}% gap)`);
        });

        // Debug: Log any stocks that were filtered out due to volume
        const allGappers = gappers.filter(stock =>
          stock.gapPercent >= this.config.gapCriteria.minGapPercentage &&
          stock.gapPercent <= this.config.gapCriteria.maxGapPercentage &&
          stock.currentPrice >= this.config.gapCriteria.minPrice &&
          stock.currentPrice <= this.config.gapCriteria.maxPrice
        );
        const volumeFiltered = allGappers.filter(stock => stock.cumulativeVolume < this.config.gapCriteria.minCumulativeVolume);
        if (volumeFiltered.length > 0) {
          console.log(`🚫 VOLUME FILTERED OUT: ${volumeFiltered.map(s => `${s.symbol}:${(s.cumulativeVolume/1000).toFixed(0)}k`).join(', ')}`);
        }
      }
      return filteredGappers;

    } catch (error) {
      console.error('Error scanning for gappers:', error);
      return Array.from(this.gapStocks.values());
    }
  }

  // Real API call using Polygon gainers endpoint
  private async fetchGappersFromAPI(): Promise<GapStock[]> {
    const now = new Date();
    const etHour = this.getETHour(now);
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (!this.polygonApiKey) {
      console.error('No Polygon API key provided - cannot fetch real market data');
      throw new Error('Polygon API key required for real market data');
    }

    try {
      console.log(`Fetching gappers from Polygon API at ET ${this.formatETTime(now)} (Hour: ${etHour.toFixed(2)})`);
      console.log(`Using config: ${this.config.gapCriteria.minGapPercentage}%+ gap, ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K+ volume, $${this.config.gapCriteria.minPrice}-${this.config.gapCriteria.maxPrice} price`);
      console.log(`Market Hours: ${this.config.marketHours.startTime} - ${this.config.marketHours.endTime} ET`);

      // Use live gainers endpoint during all configured market hours
      if (this.isWithinMarketHours(now)) {
        console.log('📈 LIVE MODE: Using live gainers endpoint (within market hours)');
        const qualifyingStocks = await this.fetchLiveGappers(today);
        console.log(`Found ${qualifyingStocks.length} qualifying gap stocks:`, qualifyingStocks.map(s => s.symbol));
        return qualifyingStocks;
      } else {
        console.log('🕐 MARKET CLOSED: Outside configured market hours, using historical data');
        const qualifyingStocks = await this.fetchHistoricalGappers(today);
        console.log(`Found ${qualifyingStocks.length} historical gap stocks:`, qualifyingStocks.map(s => s.symbol));
        return qualifyingStocks;
      }

    } catch (error) {
      console.error('Error fetching gainers:', error);
      throw error; // Propagate error instead of falling back to mock data
    }
  }

  // Fetch live gappers using real-time snapshot data
  private async fetchLiveGappers(today: string): Promise<GapStock[]> {
    const gainersUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apikey=${this.polygonApiKey}`;

    console.log('Fetching live gainers from Polygon API...');
    const gainersData = await this.cachedFetch(gainersUrl);

    if (gainersData.status !== 'OK' || !gainersData.tickers) {
      console.warn('No real-time gainers data available');
      return [];
    }

    console.log(`Processing ${gainersData.tickers.length} real-time gainers for live gaps`);

    // Filter using the actual snapshot data structure from your example
    const qualifyingStocks: GapStock[] = [];

    for (const ticker of gainersData.tickers) {
      try {
        // Extract data according to the actual snapshot structure
        const lastPrice = ticker.lastTrade?.p;         // lastTrade.p (current price)
        const avgVolume = ticker.min?.av;              // min.av (average volume)
        const changePerc = ticker.todaysChangePerc;    // todaysChangePerc (gap percentage)
        const tickerSymbol = ticker.ticker;            // ticker symbol
        const previousClose = ticker.prevDay?.c;       // Previous day close for gap calculation

        if (!lastPrice || !avgVolume || !changePerc || !tickerSymbol || !previousClose) {
          continue; // Skip if missing required data
        }

        // Apply your specified criteria: $1-$20 price, >500k volume, >20% gap
        const priceInRange = lastPrice >= this.config.gapCriteria.minPrice && lastPrice <= this.config.gapCriteria.maxPrice;
        const volumeQualified = avgVolume >= this.config.gapCriteria.minCumulativeVolume;
        const gapQualified = changePerc >= this.config.gapCriteria.minGapPercentage;

        if (priceInRange && volumeQualified && gapQualified) {
          console.log(`✅ ${tickerSymbol}: QUALIFIED - ${changePerc.toFixed(1)}% gap, ${(avgVolume/1000).toFixed(0)}K volume, $${lastPrice.toFixed(2)}`);

          // Create gap stock from live data
          const gapStock: GapStock = {
            symbol: tickerSymbol,
            gapPercent: changePerc,
            currentPrice: lastPrice,
            previousClose: previousClose,
            volume: avgVolume,
            cumulativeVolume: avgVolume, // Use min.av as cumulative volume
            hod: ticker.day?.h || lastPrice, // Use day high or current price
            lastUpdated: Date.now(),
            ema200: undefined
          };

          qualifyingStocks.push(gapStock);
        } else {
          const reasons = [];
          if (!priceInRange) reasons.push(`price $${lastPrice.toFixed(2)} not in $${this.config.gapCriteria.minPrice}-$${this.config.gapCriteria.maxPrice}`);
          if (!volumeQualified) reasons.push(`volume ${(avgVolume/1000).toFixed(0)}K < ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K`);
          if (!gapQualified) reasons.push(`gap ${changePerc.toFixed(1)}% < ${this.config.gapCriteria.minGapPercentage}%`);

          if (this.config.development.enableDebugLogging) {
            console.log(`❌ ${tickerSymbol}: REJECTED - ${reasons.join(', ')}`);
          }
        }
      } catch (error) {
        console.warn(`Error processing ticker data:`, error);
      }
    }

    console.log(`Final qualifying live gap stocks: ${qualifyingStocks.length}`);
    return qualifyingStocks;
  }

  // Calculate accurate premarket volume from minute bars (4:00 AM to current time)
  private async getPremarketVolume(symbol: string, date: string): Promise<number | null> {
    try {
      // Get current time to determine end of premarket volume calculation
      const now = this.getCurrentTime();
      const marketStart = this.getMarketStartTime();
      const marketOpen = new Date(marketStart);
      marketOpen.setHours(9, 30, 0, 0); // 9:30 AM ET

      // Use current time if we're still in premarket, otherwise use market open
      const endTime = now < marketOpen ? now : marketOpen;

      console.log(`Calculating premarket volume for ${symbol} from ${this.formatETTime(marketStart)} to ${this.formatETTime(endTime)}`);

      // Get minute bars for the premarket period
      const bars = await this.getHistoricalBars(symbol, marketStart, endTime);

      if (bars.length === 0) {
        console.warn(`No premarket bars found for ${symbol}`);
        return null;
      }

      // Sum up volume from all premarket bars (4:00 AM to current time or 9:30 AM)
      const totalPremarketVolume = bars.reduce((sum, bar) => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        // Only count bars in premarket hours (4:00 AM - 9:30 AM ET)
        if (etHour >= 4 && etHour < 9.5) {
          return sum + bar.v;
        }
        return sum;
      }, 0);

      console.log(`${symbol}: Calculated premarket volume = ${(totalPremarketVolume/1000).toFixed(0)}K from ${bars.length} minute bars`);

      return totalPremarketVolume;

    } catch (error) {
      console.error(`Error calculating premarket volume for ${symbol}:`, error);
      return null;
    }
  }

  // Initialize or update pattern state for a symbol from historical bars
  private initializePatternState(symbol: string, bars: PolygonBar[]): void {
    if (bars.length === 0) return;

    // Calculate HOD from all bars
    const hod = Math.max(...bars.map(bar => bar.h));

    // Calculate consecutive green candles and green run state
    let consecutiveGreen = 0;
    let lastBarWasGreen = false;
    let greenRunStartPrice: number | undefined;

    // Process bars in chronological order to build state
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const isGreen = bar.c > bar.o;

      if (isGreen) {
        if (!lastBarWasGreen) {
          // Starting a new green run
          greenRunStartPrice = bar.o;
          consecutiveGreen = 1;
        } else {
          // Continuing green run
          consecutiveGreen++;
        }
        lastBarWasGreen = true;
      } else {
        // Red bar - reset green run
        consecutiveGreen = 0;
        lastBarWasGreen = false;
        greenRunStartPrice = undefined;
      }
    }

    const lastBar = bars[bars.length - 1];

    this.patternStates.set(symbol, {
      hod,
      consecutiveGreenCandles: consecutiveGreen,
      lastBarWasGreen,
      greenRunStartPrice,
      lastAnalyzedBarTimestamp: lastBar.t
    });

    console.log(`Initialized pattern state for ${symbol}: HOD=${hod.toFixed(2)}, ConsecGreen=${consecutiveGreen}, LastGreen=${lastBarWasGreen}`);
  }


  // Fetch historical gappers for consistent results outside pre-market
  private async fetchHistoricalGappers(today: string): Promise<GapStock[]> {
    console.log('Using historical analysis for consistent gap stock detection');

    try {
      // Get historical gap stocks that qualified today
      const historicalGapStocks = await this.getHistoricalGapStocks(today);
      return historicalGapStocks;
    } catch (error) {
      console.warn('Historical analysis failed:', error);
      return [];
    }
  }


  // Enhanced backfill data using Polygon REST API for historical 1-minute bars
  async backfillMissedData(): Promise<Alert[]> {
    const now = this.getCurrentTime();
    const startTime = this.getMarketStartTime();
    const marketEnd = this.getMarketEndTime();

    if (this.config.development.enableDebugLogging) {
      console.log('=== ENHANCED BACKFILL DEBUG ===');
      console.log('Current time:', this.formatETTime(now));
      console.log(`${this.config.marketHours.startTime} ET:`, this.formatETTime(startTime));
      console.log(`${this.config.marketHours.endTime} ET:`, this.formatETTime(marketEnd));
      console.log('API Key available:', !!this.polygonApiKey);
      console.log('Extended Hours Support:', this.config.marketHours.endTime === '16:00' ? '✅' : '❌');
    }

    // Determine current ET time for session analysis
    const etHour = this.getETHour(now);
    const isPremarket = etHour >= 4 && etHour < 9.5;
    const isRegularHours = etHour >= 9.5 && etHour < 16;
    const isAfterHours = etHour >= 16 || etHour < 4;

    console.log(`📊 Session Analysis: Premarket=${isPremarket}, Regular=${isRegularHours}, After=${isAfterHours}, Current=${etHour.toFixed(2)}`);

    // Enhanced backfill logic for extended hours support
    let endTime: number;
    let backfillReason: string;

    if (!this.isWithinMarketHours(now) && now.getTime() < startTime.getTime()) {
      if (this.config.development.enableDebugLogging) {
        console.log('🕐 Before market hours - no backfill needed');
      }
      return [];
    } else if (this.isWithinMarketHours(now)) {
      // During configured market hours: backfill from start time to current time
      endTime = now.getTime();
      backfillReason = `Market session active (${isPremarket ? 'premarket' : isRegularHours ? 'regular' : 'extended'})`;

      if (this.config.development.enableDebugLogging) {
        console.log(`🔴 LIVE BACKFILL: ${backfillReason} - backfilling from ${this.config.marketHours.startTime} to current time`);
      }
    } else {
      // After market hours: backfill the complete configured session
      endTime = marketEnd.getTime();
      backfillReason = `Market closed - complete session`;

      if (this.config.development.enableDebugLogging) {
        console.log(`⏹️ COMPLETE BACKFILL: ${backfillReason} (${this.config.marketHours.startTime} - ${this.config.marketHours.endTime})`);
      }
    }

    const backfillStartTime = this.formatETTime(startTime);
    const backfillEndTime = this.formatETTime(new Date(endTime));
    console.log(`🔄 Backfilling from ${backfillStartTime} to ${backfillEndTime} (${backfillReason})`);

    // Use today's date in ET timezone for historical scan
    const etNowForDate = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const todayDateString = `${etNowForDate.getFullYear()}-${String(etNowForDate.getMonth() + 1).padStart(2, '0')}-${String(etNowForDate.getDate()).padStart(2, '0')}`;
    console.log(`📅 Using today's date (ET timezone) for backfill: ${todayDateString}`);

    try {
      // Get today's historical alerts with enhanced filtering for extended hours
      const backfilledAlerts = await this.getHistoricalAlertsForDate(todayDateString);

      // Filter alerts to only include those in our backfill time window
      const filteredAlerts = backfilledAlerts.filter(alert => {
        const alertTime = new Date(alert.timestamp);
        const inTimeWindow = alert.timestamp >= startTime.getTime() && alert.timestamp <= endTime;

        if (this.config.development.enableDebugLogging && !inTimeWindow) {
          console.log(`⏰ FILTERING OUT ALERT: ${alert.symbol} at ${this.formatETTime(alertTime)} (outside window ${backfillStartTime} - ${backfillEndTime})`);
        }

        return inTimeWindow;
      });

      console.log(`✅ Backfilled ${filteredAlerts.length} alerts from ${backfillStartTime} to ${backfillEndTime}`);

      if (this.config.development.enableDebugLogging && backfilledAlerts.length > filteredAlerts.length) {
        console.log(`📊 BACKFILL FILTER STATS: ${backfilledAlerts.length} total alerts → ${filteredAlerts.length} in time window (filtered out ${backfilledAlerts.length - filteredAlerts.length})`);
      }

      // Additional session breakdown for extended hours
      if (this.config.development.enableDebugLogging && this.config.marketHours.endTime === '16:00') {
        const premarketAlerts = filteredAlerts.filter(alert => {
          const alertHour = this.getETHour(new Date(alert.timestamp));
          return alertHour >= 4 && alertHour < 9.5;
        });

        const regularHoursAlerts = filteredAlerts.filter(alert => {
          const alertHour = this.getETHour(new Date(alert.timestamp));
          return alertHour >= 9.5 && alertHour < 16;
        });

        console.log(`📈 SESSION BREAKDOWN: Premarket=${premarketAlerts.length}, Regular=${regularHoursAlerts.length}`);
      }

      return filteredAlerts.sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      console.error('Enhanced backfill failed:', error);

      // If no API key, throw error instead of using mock data
      if (!this.polygonApiKey) {
        console.error('No Polygon API key provided - cannot generate historical alerts');
        throw new Error('Polygon API key required for historical backfill');
      }

      return [];
    }
  }

  // Start continuous backfill-based scanning
  startScanning(): void {
    if (this.isScanning) return;

    this.isScanning = true;
    console.log('Starting continuous backfill-based signal detection every 30 seconds on :00 and :30...');

    // Initial scan for gap stocks
    this.scanForGappers();

    // Schedule first backfill at next :00 or :30 second mark
    this.scheduleNextBackfill();
  }

  // Schedule backfill to run on :00 and :30 second marks
  private scheduleNextBackfill(): void {
    const now = new Date();
    const currentSeconds = now.getSeconds();

    // Calculate milliseconds until next :00 or :30 second mark
    let secondsUntilNext: number;
    if (currentSeconds < 30) {
      secondsUntilNext = 30 - currentSeconds;
    } else {
      secondsUntilNext = 60 - currentSeconds;
    }

    const msUntilNext = (secondsUntilNext * 1000) - now.getMilliseconds();

    if (this.config.development.enableDebugLogging) {
      console.log(`📅 Next backfill scheduled in ${(msUntilNext/1000).toFixed(1)} seconds`);
    }

    // Schedule the next backfill
    setTimeout(() => {
      this.performScheduledBackfill();

      // Set up regular interval for every 30 seconds
      this.scanInterval = window.setInterval(() => {
        this.performScheduledBackfill();
      }, this.config.scanning.backfillInterval);

    }, msUntilNext);
  }

  // Perform backfill on schedule
  private async performScheduledBackfill(): Promise<void> {
    try {
      const now = this.getCurrentTime();

      // Only scan during configured market hours
      if (this.isWithinMarketHours(now)) {
        if (this.config.development.enableDebugLogging) {
          console.log(`🔄 Running scheduled backfill at ${this.formatETTime(now)} (:${now.getSeconds().toString().padStart(2, '0')})`);
        }

        // Update gap stocks first
        await this.scanForGappers();

        // Perform backfill to get latest signals
        await this.performContinuousBackfill();
      } else {
        if (this.config.development.enableDebugLogging) {
          console.log(`🕐 Outside market hours at ${this.formatETTime(now)} - skipping backfill scan`);
        }
      }
    } catch (error) {
      console.error('Error in scheduled backfill:', error);
    }
  }

  // Perform continuous backfill and fire new alerts with sound notifications
  private async performContinuousBackfill(): Promise<void> {
    try {
      const now = Date.now();

      // Get the latest signals from backfill
      const backfilledAlerts = await this.backfillMissedData();

      // Find new alerts since last backfill
      const newAlerts = backfilledAlerts.filter(alert =>
        alert.timestamp > this.lastBackfillTime
      );

      if (newAlerts.length > 0) {
        console.log(`🔔 Found ${newAlerts.length} new signals from continuous backfill`);

        // Fire each new alert through the callback system (triggers sound)
        newAlerts.forEach(alert => {
          this.fireAlert(alert);
        });
      } else if (this.config.development.enableDebugLogging) {
        console.log(`✅ Continuous backfill complete - no new signals since ${new Date(this.lastBackfillTime).toLocaleTimeString()}`);
      }

      // Update last backfill time
      this.lastBackfillTime = now;

    } catch (error) {
      console.error('Error in continuous backfill:', error);
    }
  }

  // Stop scanning
  stopScanning(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.isScanning = false;
    console.log('Gap stock scanner stopped');
  }

  // Get current qualified symbols
  getQualifiedSymbols(): string[] {
    return Array.from(this.gapStocks.keys());
  }

  // Get symbol data
  getSymbolData(): SymbolData[] {
    return Array.from(this.gapStocks.values()).map(stock => ({
      symbol: stock.symbol,
      lastPrice: stock.currentPrice,
      gapPercent: stock.gapPercent,
      volume: stock.cumulativeVolume,
      hod: stock.hod,
      bid: stock.currentPrice - this.config.scanning.bidAskSpread,
      ask: stock.currentPrice + this.config.scanning.bidAskSpread
    }));
  }

  // Register alert callback
  onAlert(callback: (alert: Alert) => void): void {
    this.alertCallbacks.push(callback);
  }

  // Fire alert to all callbacks with proper deduplication
  private fireAlert(alert: Alert): void {
    // Check if we've already fired this specific alert
    if (this.firedAlertIds.has(alert.id)) {
      return; // Skip duplicate alert
    }

    // Mark alert as fired
    this.firedAlertIds.add(alert.id);

    // Clean up old alert IDs to prevent memory leak (keep last 1000)
    if (this.firedAlertIds.size > 1000) {
      const alertIds = Array.from(this.firedAlertIds);
      const oldIds = alertIds.slice(0, alertIds.length - 500); // Remove oldest 500
      oldIds.forEach(id => this.firedAlertIds.delete(id));
    }

    // Fire alert to all callbacks
    this.alertCallbacks.forEach(callback => {
      try {
        callback(alert);
      } catch (error) {
        console.error('Error in alert callback:', error);
      }
    });

    console.log(`🔔 FIRED ALERT: ${alert.type} for ${alert.symbol} at ${new Date(alert.timestamp).toLocaleTimeString()}`);
  }

  // Scan for live patterns during premarket hours

  // Get historical alerts for a specific date
  async getHistoricalAlertsForDate(dateString: string): Promise<Alert[]> {
    try {
      console.log(`=== HISTORICAL SCAN FOR ${dateString} ===`);

      // Parse date string properly to avoid timezone issues
      const [year, month, day] = dateString.split('-').map(Number);
      const date = new Date(year, month - 1, day); // month is 0-indexed

      console.log(`Parsed date: ${date.toDateString()} (input: ${dateString})`);

      // Validate date
      if (isNaN(date.getTime())) {
        throw new Error('Invalid date format');
      }

      // Check if it's a weekend
      if (date.getDay() === 0 || date.getDay() === 6) {
        throw new Error('Markets are closed on weekends');
      }

      // Check if it's not too far in the past (API limitations)
      const daysAgo = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
      if (daysAgo > this.config.historical.maxLookbackDays) {
        throw new Error('Historical data only available for the last 2 years');
      }

      // Get gap stocks that qualified on this date with proper filtering
      console.log(`Step 1: Finding gap stocks for ${dateString} with criteria: 20%+ gap, 500k+ volume, $1-$10 price`);
      const historicalGapStocks = await this.getHistoricalGapStocks(dateString);

      if (historicalGapStocks.length === 0) {
        console.log('No qualifying gap stocks found for this date');
        return [];
      }

      console.log(`Step 2: Found ${historicalGapStocks.length} qualifying gap stocks:`, historicalGapStocks.map(s => `${s.symbol} (${s.gapPercent.toFixed(1)}%, ${(s.cumulativeVolume/1000).toFixed(0)}k vol, $${s.currentPrice.toFixed(2)})`));

      // Get alerts for each gap stock during pre-market hours (4:00 AM - 9:30 AM ET)
      const allAlerts: Alert[] = [];

      for (const gapStock of historicalGapStocks) {
        try {
          console.log(`Step 3: Scanning ${gapStock.symbol} for patterns (${(gapStock.cumulativeVolume/1000).toFixed(0)}k vol)...`);
          const stockAlerts = await this.scanHistoricalStock(gapStock.symbol, dateString, gapStock.cumulativeVolume, gapStock.gapPercent);
          if (stockAlerts.length > 0) {
            console.log(`Found ${stockAlerts.length} patterns for ${gapStock.symbol}:`, stockAlerts.map(a => a.type));
          }
          allAlerts.push(...stockAlerts);
        } catch (error) {
          console.warn(`Failed to scan historical data for ${gapStock.symbol}:`, error);
        }
      }

      console.log(`Step 4: Generated ${allAlerts.length} total historical alerts for ${dateString}`);

      // Sort by timestamp
      return allAlerts.sort((a, b) => a.timestamp - b.timestamp);

    } catch (error) {
      console.error('Failed to get historical alerts:', error);
      throw error;
    }
  }

  // Get gap stocks that qualified on a historical date
  private async getHistoricalGapStocks(dateString: string): Promise<GapStock[]> {
    if (!this.polygonApiKey) {
      console.error('No Polygon API key provided - cannot fetch historical gap stocks');
      throw new Error('Polygon API key required for historical data');
    }

    try {
      // Get grouped daily data for the date to find gap stocks
      const date = dateString; // Already in YYYY-MM-DD format
      const groupedUrl = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apikey=${this.polygonApiKey}`;

      console.log('Fetching grouped daily data for historical analysis...');
      const groupedData = await this.cachedFetch(groupedUrl);

      if (!groupedData.results || groupedData.results.length === 0) {
        console.warn('No grouped data available for this date');
        return [];
      }

      // Get previous day's data to calculate gaps
      const previousDate = this.getPreviousTradingDay(date);
      const prevGroupedUrl = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${previousDate}?adjusted=true&apikey=${this.polygonApiKey}`;

      const prevGroupedData = await this.cachedFetch(prevGroupedUrl);
      const prevCloses = new Map();

      if (prevGroupedData.results) {
        prevGroupedData.results.forEach((bar: any) => {
          if (bar.T) {
            prevCloses.set(bar.T, bar.c);
          }
        });
      }

      // Find qualifying gap stocks
      const qualifyingStocks: GapStock[] = [];

      for (const bar of groupedData.results) {
        if (!bar.T || !bar.o || !bar.v) continue; // Skip invalid data

        const symbol = bar.T;
        const previousClose = prevCloses.get(symbol);

        if (!previousClose) continue;

        const gapPercent = ((bar.o - previousClose) / previousClose) * 100;

        // Filter for our criteria using configuration
        if (gapPercent >= this.config.gapCriteria.minGapPercentage &&
            bar.v >= this.config.gapCriteria.minCumulativeVolume &&
            bar.o >= this.config.gapCriteria.minPrice &&
            bar.o <= this.config.gapCriteria.maxPrice) {
          qualifyingStocks.push({
            symbol,
            gapPercent,
            currentPrice: bar.c,
            previousClose,
            volume: bar.v,
            cumulativeVolume: bar.v,
            hod: bar.h,
            lastUpdated: Date.now(),
          });
        }
      }

      console.log(`Found ${qualifyingStocks.length} qualifying historical gap stocks`);
      return qualifyingStocks.slice(0, this.config.historical.maxSymbolsToAnalyze); // Limit for performance

    } catch (error) {
      console.error('Failed to fetch historical gap stocks:', error);
      throw error;
    }
  }

  // Get previous trading day (handles weekends properly)
  private getPreviousTradingDay(dateString: string): string {
    // Parse date string properly to avoid timezone issues
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day); // month is 0-indexed

    // Move back one day
    date.setDate(date.getDate() - 1);

    // If it's a weekend, go back to Friday
    if (date.getDay() === 0) { // Sunday
      date.setDate(date.getDate() - 2); // Go back to Friday
    } else if (date.getDay() === 6) { // Saturday
      date.setDate(date.getDate() - 1); // Go back to Friday
    }

    // Format the date in local time to avoid timezone issues
    const year2 = date.getFullYear();
    const month2 = String(date.getMonth() + 1).padStart(2, '0');
    const day2 = String(date.getDate()).padStart(2, '0');
    return `${year2}-${month2}-${day2}`;
  }


  // Scan a specific stock for historical patterns on a specific date
  private async scanHistoricalStock(symbol: string, dateString: string, cumulativeVolume?: number, gapPercent?: number): Promise<Alert[]> {
    try {
      // Get 1-minute bars for pre-market hours (4:00 AM - 9:30 AM ET)
      const bars = await this.getHistoricalMinuteBars(symbol, dateString);

      if (bars.length === 0) {
        return [];
      }

      // CRITICAL SAFETY CHECK: Ensure cumulative volume meets requirements (historical path)
      if (cumulativeVolume !== undefined) {
        if (cumulativeVolume < this.config.gapCriteria.minCumulativeVolume) {
          console.error(`🚨 HISTORICAL VOLUME SAFETY FILTER: ${symbol} has ${(cumulativeVolume/1000).toFixed(0)}k cumulative volume < ${this.config.gapCriteria.minCumulativeVolume/1000}k required - BLOCKING ALL HISTORICAL PATTERNS`);
          return [];
        } else {
          console.log(`✅ ${symbol} HISTORICAL VOLUME OK: ${(cumulativeVolume/1000).toFixed(0)}k cumulative volume ≥ ${this.config.gapCriteria.minCumulativeVolume/1000}k required`);
        }
      }

      // Calculate HOD from the bars
      const hod = Math.max(...bars.map(bar => bar.h));

      const alerts: Alert[] = [];

      // Scan each bar for patterns
      bars.forEach((bar, index) => {
        const timestamp = new Date(bar.t);

        // Skip if outside configured market hours
        const etHour = this.getETHour(timestamp);
        const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);
        const [endHour, endMin] = this.config.marketHours.endTime.split(':').map(Number);
        const startTimeInHours = startHour + startMin / 60;
        const endTimeInHours = endHour + endMin / 60;

        if (etHour < startTimeInHours || etHour >= endTimeInHours) {
          return;
        }

        // ADDITIONAL SAFETY CHECK: Re-verify cumulative volume before each pattern detection
        if (cumulativeVolume !== undefined && cumulativeVolume < this.config.gapCriteria.minCumulativeVolume) {
          console.error(`🚨 HISTORICAL PATTERN BLOCKED: ${symbol} volume=${(cumulativeVolume/1000).toFixed(0)}k < ${this.config.gapCriteria.minCumulativeVolume/1000}k at bar ${index}`);
          return; // Skip this bar entirely
        }

        // Check all pattern types (pass cumulative volume for display)
        const patterns = [
          this.detectToppingTail(symbol, bar, timestamp, hod, cumulativeVolume, gapPercent),
          this.detectHODBreakCloseUnder(symbol, bars, index, hod, timestamp, cumulativeVolume, gapPercent),
          this.detectGreenThenRed(symbol, bars, index, timestamp, hod, cumulativeVolume, gapPercent),
          // Note: EMA200 pattern would need additional data
        ];

        patterns.forEach(alert => {
          if (alert) {
            console.log(`📍 HISTORICAL ALERT GENERATED: ${symbol} ${alert.type} with ${cumulativeVolume ? (cumulativeVolume/1000).toFixed(0) + 'k' : 'unknown'} cumulative volume`);
            alerts.push(alert);
          }
        });
      });

      return alerts;

    } catch (error) {
      console.warn(`Failed to scan historical data for ${symbol}:`, error);
      return [];
    }
  }

  // Get historical 1-minute bars for a specific date
  private async getHistoricalMinuteBars(symbol: string, dateString: string): Promise<PolygonBar[]> {
    if (!this.polygonApiKey) {
      console.error(`No Polygon API key provided - cannot fetch minute bars for ${symbol}`);
      throw new Error('Polygon API key required for minute bar data');
    }

    try {
      const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${dateString}/${dateString}?adjusted=true&sort=asc&limit=${this.config.api.aggregatesLimit}&apikey=${this.polygonApiKey}`;

      const data = await this.cachedFetch(url);

      if (!data.results || data.results.length === 0) {
        console.warn(`No minute bars found for ${symbol} on ${dateString}`);
        return [];
      }

      return data.results;

    } catch (error) {
      console.error(`Failed to fetch minute bars for ${symbol} on ${dateString}:`, error);
      throw error;
    }
  }


  // Helper methods
  private getETHour(date: Date): number {
    // Use proper ET timezone conversion
    const etTime = new Date(date.toLocaleString("en-US", {timeZone: "America/New_York"}));
    return etTime.getHours() + etTime.getMinutes() / 60;
  }

  private getMarketStartTime(): Date {
    const now = this.getCurrentTime();
    const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);

    // Get current ET time
    const etTime = new Date(now.toLocaleString("en-US", {timeZone: this.config.marketHours.timezone}));
    // Create start time ET today in local timezone
    const startTimeET = new Date(etTime.getFullYear(), etTime.getMonth(), etTime.getDate(), startHour, startMin, 0);
    // Convert from ET back to UTC/local
    const utcOffset = now.getTimezoneOffset() * 60000;
    const etOffset = startTimeET.getTimezoneOffset() * 60000;
    return new Date(startTimeET.getTime() + etOffset - utcOffset);
  }

  private getMarketEndTime(): Date {
    const now = this.getCurrentTime();
    const [endHour, endMin] = this.config.marketHours.endTime.split(':').map(Number);

    // Get current ET time
    const etTime = new Date(now.toLocaleString("en-US", {timeZone: this.config.marketHours.timezone}));
    // Create end time ET today in local timezone
    const endTimeET = new Date(etTime.getFullYear(), etTime.getMonth(), etTime.getDate(), endHour, endMin, 0);
    // Convert from ET back to UTC/local
    const utcOffset = now.getTimezoneOffset() * 60000;
    const etOffset = endTimeET.getTimezoneOffset() * 60000;
    return new Date(endTimeET.getTime() + etOffset - utcOffset);
  }

  private formatETTime(date: Date): string {
    return date.toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
  }

  // Calculate extended HOD including previous day after-hours (4:00-8:00 PM) + current pre-market (4:00 AM-9:30 AM)
  private async getExtendedHOD(symbol: string, preMarketBars: PolygonBar[]): Promise<number> {
    try {
      // First get the HOD from current pre-market bars
      const preMarketHOD = preMarketBars.length > 0 ? Math.max(...preMarketBars.map(bar => bar.h)) : 0;

      // Get previous trading day's after-hours bars (4:00-8:00 PM ET)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const afterHoursBars = await this.getAfterHoursBars(symbol, yesterdayStr);
      const afterHoursHOD = afterHoursBars.length > 0 ? Math.max(...afterHoursBars.map(bar => bar.h)) : 0;

      // Return the higher of the two HODs
      const extendedHOD = Math.max(preMarketHOD, afterHoursHOD);

      console.log(`📈 ${symbol} Extended HOD: Pre-market: $${preMarketHOD.toFixed(2)}, After-hours: $${afterHoursHOD.toFixed(2)}, Combined: $${extendedHOD.toFixed(2)}`);

      return extendedHOD;
    } catch (error) {
      console.error(`Error calculating extended HOD for ${symbol}:`, error);
      // Fallback to pre-market HOD only
      return preMarketBars.length > 0 ? Math.max(...preMarketBars.map(bar => bar.h)) : 0;
    }
  }

  // Get after-hours bars for previous day (4:00-8:00 PM ET)
  private async getAfterHoursBars(symbol: string, date: string): Promise<PolygonBar[]> {
    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=${this.config.api.aggregatesLimit}&apikey=${this.polygonApiKey}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return [];
      }

      const data: PolygonAggregatesResponse = await response.json();
      if (data.status !== 'OK' || !data.results) {
        return [];
      }

      // Filter to after-hours (4:00-8:00 PM ET)
      const filteredBars = data.results.filter(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= 16 && etHour < 20; // 4:00 PM - 8:00 PM ET
      });

      console.log(`📊 ${symbol} After-hours bars (${date}): ${filteredBars.length}`);
      return filteredBars;

    } catch (error) {
      console.error(`Error fetching after-hours data for ${symbol}:`, error);
      return [];
    }
  }

  private generateProperCandleTimes(start: Date, end: Date): number[] {
    const times: number[] = [];
    const startTime = start.getTime();
    const endTime = end.getTime();

    // Generate times on proper candle intervals (every 1 or 5 minutes on the dot)
    let current = new Date(startTime);

    // Round to next minute boundary
    current.setSeconds(0, 0);
    if (current.getTime() < startTime) {
      current.setMinutes(current.getMinutes() + 1);
    }

    while (current.getTime() < endTime) {
      // 1-minute patterns can trigger on any minute (1:00, 1:01, 1:02, etc.)
      // 5-minute patterns only trigger on 5-minute intervals (1:00, 1:05, 1:10, etc.)
      if (Math.random() > 0.7) { // 30% chance of alert per minute
        times.push(current.getTime());
      }

      // Advance by 1 minute for proper candle timing
      current.setMinutes(current.getMinutes() + 1);
    }

    return times;
  }

  private getPatternTypeForTime(alertTime: Date): PatternType {
    const minute = alertTime.getMinutes();

    // 5-minute patterns (ToppingTail5m) only trigger on 5-minute intervals (0, 5, 10, 15, etc.)
    const is5MinuteInterval = minute % 5 === 0;

    const oneMinutePatterns: PatternType[] = [
      'ToppingTail1m', 'HODBreakCloseUnder',
      'Run4PlusGreenThenRed'
    ];

    const fiveMinutePatterns: PatternType[] = [
      'HODBreakCloseUnder'
    ];

    // Use 5-minute patterns on 5-minute intervals, otherwise use 1-minute patterns
    const availablePatterns = is5MinuteInterval && Math.random() > 0.5
      ? fiveMinutePatterns
      : oneMinutePatterns;

    return availablePatterns[Math.floor(Math.random() * availablePatterns.length)];
  }

  private getRandomPatternType(): PatternType {
    const patterns: PatternType[] = [
      'ToppingTail1m', 'HODBreakCloseUnder',
      'Run4PlusGreenThenRed'
    ];
    return patterns[Math.floor(Math.random() * patterns.length)];
  }

  // Get market open price for a specific symbol and date
  async getMarketOpenPrice(symbol: string, dateString: string): Promise<number> {
    if (!this.polygonApiKey) {
      throw new Error('Polygon API key required for market open price');
    }

    try {
      // Get daily OHLC data for the specific date
      const url = `https://api.polygon.io/v1/open-close/${symbol}/${dateString}?adjusted=true&apikey=${this.polygonApiKey}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.status !== 'OK' || typeof data.open !== 'number') {
        throw new Error(`No open price data available for ${symbol} on ${dateString}`);
      }

      console.log(`📈 ${symbol} open price on ${dateString}: $${data.open.toFixed(2)}`);
      return data.open;

    } catch (error) {
      console.error(`Failed to get open price for ${symbol} on ${dateString}:`, error);
      throw error;
    }
  }

  // Get historical 1-minute bars from Polygon API
  private async getHistoricalBars(symbol: string, startTime: Date, endTime: Date): Promise<PolygonBar[]> {
    const startDate = startTime.toISOString().split('T')[0]; // YYYY-MM-DD
    const endDate = endTime.toISOString().split('T')[0];

    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${startDate}/${endDate}?adjusted=true&sort=asc&limit=${this.config.api.aggregatesLimit}&apikey=${this.polygonApiKey}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: PolygonAggregatesResponse = await response.json();

      if (data.status !== 'OK' || !data.results) {
        console.warn(`No data for ${symbol}:`, data);
        return [];
      }

      // Filter bars to only include configured market hours
      const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);
      const [endHour, endMin] = this.config.marketHours.endTime.split(':').map(Number);
      const startTimeInHours = startHour + startMin / 60;
      const endTimeInHours = endHour + endMin / 60;

      const filteredBars = data.results.filter(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= startTimeInHours && etHour < endTimeInHours;
      });

      console.log(`Retrieved ${filteredBars.length} 1-minute bars for ${symbol}`);
      return filteredBars;

    } catch (error) {
      console.error(`Error fetching data for ${symbol}:`, error);
      return [];
    }
  }


  // Pattern detection methods
  private detectToppingTail(symbol: string, bar: PolygonBar, timestamp: Date, hod: number, cumulativeVolume?: number, gapPercent?: number): Alert | null {
    const fullSize = bar.h - bar.l;
    const upperWick = bar.h - Math.max(bar.o, bar.c);

    if (fullSize === 0) return null;

    const wickPercent = upperWick / fullSize;
    const isRed = bar.c < bar.o;
    const bodyPercent = (Math.abs(bar.c - bar.o) / fullSize) * 100;

    // Use configuration parameters
    const minWickPercent = this.config.patterns.toppingTail.minUpperWickPercent / 100;
    const maxBodyPercent = this.config.patterns.toppingTail.maxBodyPercent;
    const mustCloseRed = this.config.patterns.toppingTail.mustCloseRed;

    // Strict HOD check - must be within configured distance from HOD
    // Use maxHodDistancePercent for topping tail since the high touches HOD but close should still be reasonably near
    const maxDistanceThreshold = 1 - (this.config.patterns.hod.maxHodDistancePercent / 100);
    const nearHOD = bar.c >= hod * maxDistanceThreshold; // Check close price, not high

    // Check all topping tail conditions using configuration
    const validWick = wickPercent >= minWickPercent;
    const validBody = bodyPercent <= maxBodyPercent;
    const validColor = mustCloseRed ? isRed : true; // Either must be red, or any color is OK
    const validVolume = bar.v >= this.config.patterns.toppingTail.minBarVolume;

    if (validWick && validBody && validColor && validVolume && nearHOD) {
      return {
        id: `${symbol}-${timestamp.getTime()}-ToppingTail1m`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'ToppingTail1m',
        detail: `${(wickPercent * 100).toFixed(0)}% upper wick near HOD ${hod.toFixed(2)}`,
        price: bar.c,
        volume: cumulativeVolume || bar.v, // Use cumulative volume if available
        gapPercent: gapPercent,
        historical: true
      };
    }

    return null;
  }

  private detectHODBreakCloseUnder(symbol: string, bars: PolygonBar[], index: number, hod: number, timestamp: Date, cumulativeVolume?: number, gapPercent?: number): Alert | null {
    if (index < 1) return null; // Need previous bar

    const currentBar = bars[index];
    const prevBar = bars[index - 1];

    // Use configuration-based thresholds instead of hardcoded values
    const nearHodThreshold = 1 - (this.config.patterns.hod.nearHodDistancePercent / 100);
    const maxHodThreshold = 1 - (this.config.patterns.hod.maxHodDistancePercent / 100);

    // Check if previous bar broke HOD (within near threshold) and current bar closed under (within max threshold)
    const prevBarNearHod = prevBar.h >= hod * nearHodThreshold;
    const currentBarWithinMaxDistance = currentBar.c >= hod * maxHodThreshold;

    if (prevBarNearHod && currentBar.c < prevBar.h && currentBarWithinMaxDistance) {
      return {
        id: `${symbol}-${timestamp.getTime()}-HODBreakCloseUnder`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'HODBreakCloseUnder',
        detail: `Broke HOD ${hod.toFixed(2)}, closed under at ${currentBar.c.toFixed(2)}`,
        price: currentBar.c,
        volume: cumulativeVolume || currentBar.v, // Use cumulative volume if available
        gapPercent: gapPercent,
        historical: true
      };
    }

    return null;
  }


  private detectGreenThenRed(symbol: string, bars: PolygonBar[], index: number, timestamp: Date, hod: number, cumulativeVolume?: number, gapPercent?: number): Alert | null {
    const minConsecutiveGreen = this.config.patterns.greenRun.minConsecutiveGreen;
    const maxConsecutiveGreen = this.config.patterns.greenRun.maxConsecutiveGreen;

    if (index < minConsecutiveGreen) return null;

    const currentBar = bars[index];

    // FIXED: Current bar must be red (close < open)
    const currentRed = currentBar.c < currentBar.o;
    if (!currentRed) return null;

    // FIXED: Count consecutive green bars BACKWARDS from the bar immediately before current
    let consecutiveGreen = 0;
    for (let i = 1; i <= Math.min(maxConsecutiveGreen, index); i++) {
      const checkIndex = index - i;
      if (checkIndex >= 0 && bars[checkIndex].c > bars[checkIndex].o) {
        consecutiveGreen++;
      } else {
        break; // Stop at first non-green bar
      }
    }

    // Get the actual consecutive green bars that preceded the red bar
    const greenRunStartIndex = Math.max(0, index - consecutiveGreen);
    const prevBars = bars.slice(greenRunStartIndex, index);

    // Check if we have enough consecutive green bars
    const hasMinGreenRun = consecutiveGreen >= minConsecutiveGreen;

    if (!hasMinGreenRun) {
      if (this.config.development.enableDebugLogging && consecutiveGreen > 0) {
        console.log(`🟢 ${symbol}: Found ${consecutiveGreen} green bars but need ${minConsecutiveGreen}+ for signal`);
      }
      return null;
    }

    // Calculate total gain during green run to meet minimum threshold
    if (prevBars.length > 0) {
      const runStartPrice = prevBars[0].o;
      const runEndPrice = prevBars[prevBars.length - 1].c;
      const runGainPercent = ((runEndPrice - runStartPrice) / runStartPrice) * 100;

      if (runGainPercent < this.config.patterns.greenRun.minRunGainPercent) {
        if (this.config.development.enableDebugLogging) {
          console.log(`📈 ${symbol}: Green run gain ${runGainPercent.toFixed(1)}% < required ${this.config.patterns.greenRun.minRunGainPercent}%`);
        }
        return null; // Run gain too small
      }
    }

    // Only trigger near HOD (using current bar's high, not close)
    const hodDistanceThreshold = 1 - (this.config.patterns.hod.nearHodDistancePercent / 100);
    const nearHOD = currentBar.h >= hod * hodDistanceThreshold;

    if (!nearHOD) {
      if (this.config.development.enableDebugLogging) {
        const distanceFromHod = ((hod - currentBar.h) / hod) * 100;
        console.log(`🎯 ${symbol}: Not near HOD - ${distanceFromHod.toFixed(1)}% from HOD ${hod.toFixed(2)} (need within ${this.config.patterns.hod.nearHodDistancePercent}%)`);
      }
      return null;
    }

    if (this.config.development.enableDebugLogging) {
      console.log(`🔴 ${symbol}: QUALIFIED GREEN-THEN-RED - ${consecutiveGreen} green bars then red near HOD ${hod.toFixed(2)}`);
    }

    return {
      id: `${symbol}-${timestamp.getTime()}-Run4PlusGreenThenRed`,
      timestamp: timestamp.getTime(),
      symbol,
      type: 'Run4PlusGreenThenRed',
      detail: `${consecutiveGreen} green candles then red near HOD ${hod.toFixed(2)}`,
      price: currentBar.c,
      volume: cumulativeVolume || currentBar.v, // Use cumulative volume if available
      gapPercent: gapPercent,
      historical: true
    };
  }





  // Scan for historical gap stocks using a broader universe approach
  private async scanHistoricalGappers(startTime: Date, endTime: Date): Promise<GapStock[]> {
    if (!this.polygonApiKey) {
      console.error('No Polygon API key provided - cannot scan historical gappers');
      throw new Error('Polygon API key required for historical gap scanning');
    }

    try {
      console.log('Scanning broader universe for historical gap stocks...');
      const today = startTime.toISOString().split('T')[0];
      // Get broader universe approach for historical data

      // Use Polygon's grouped daily bars to get a broader universe
      // This endpoint provides data for all tickers that had activity
      const groupedUrl = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${today}?adjusted=true&apikey=${this.polygonApiKey}`;

      console.log('Fetching grouped daily data for broader symbol universe...');
      const response = await fetch(groupedUrl);

      if (!response.ok) {
        console.warn('Grouped daily data not available, using snapshot approach');
        return this.scanWithSnapshotApproach(today);
      }

      const data: PolygonAggregatesResponse = await response.json();

      if (!data.results || data.results.length === 0) {
        console.warn('No grouped data available, using snapshot approach');
        return this.scanWithSnapshotApproach(today);
      }

      console.log(`Found ${data.results.length} symbols with activity today`);

      // Filter and analyze symbols with significant volume and movement
      const qualifyingStocks: GapStock[] = [];

      // Log total symbols and volume distribution
      console.log(`Total symbols in grouped data: ${data.results.length}`);
      const volumeSorted = data.results
        .filter(bar => bar.v > 0)
        .sort((a, b) => b.v - a.v);
      console.log(`Top 10 by volume:`, volumeSorted.slice(0, 10).map(bar => `${bar.T}:${(bar.v/1000).toFixed(0)}k`));

      const symbolsToCheck = data.results
        .filter(bar => bar.v >= this.config.historical.minVolumeForDiscovery) // Volume filter for discovery
        .sort((a, b) => b.v - a.v) // Sort by volume descending
        .slice(0, 300) // Increased from 200 to 300 symbols
        .map(bar => ({ symbol: bar.T || 'UNKNOWN', volume: bar.v }));

      console.log(`Analyzing ${symbolsToCheck.length} symbols (≥50k volume) for gaps...`);
      console.log('Sample symbols to check:', symbolsToCheck.slice(0, 20).map(s => `${s.symbol}:${(s.volume/1000).toFixed(0)}k`));

      // Check symbols in batches to avoid rate limits
      for (let i = 0; i < symbolsToCheck.length; i += 10) {
        const batch = symbolsToCheck.slice(i, i + 10);

        const batchPromises = batch.map(async ({ symbol }) => {
          try {
            const gapStock = await this.analyzeStockForGap(symbol, today);
            return gapStock;
          } catch (error) {
            console.warn(`Error analyzing ${symbol}:`, error);
            return null;
          }
        });

        const batchResults = await Promise.allSettled(batchPromises);
        const validStocks = batchResults
          .filter(result => result.status === 'fulfilled' && result.value !== null)
          .map(result => (result as PromiseFulfilledResult<GapStock>).value);

        qualifyingStocks.push(...validStocks);

        // Small delay between batches to respect rate limits
        if (i + 10 < symbolsToCheck.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      console.log(`Found ${qualifyingStocks.length} qualifying historical gap stocks`);

      // Return only real gap stocks found
      return qualifyingStocks;

    } catch (error) {
      console.error('Error scanning historical gappers:', error);
      throw error;
    }
  }

  // Fallback approach using market snapshot
  private async scanWithSnapshotApproach(date: string): Promise<GapStock[]> {
    try {
      console.log('Using market snapshot approach for symbol discovery...');

      // Get market snapshot for all equities
      const snapshotUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?apikey=${this.polygonApiKey}`;
      const response = await fetch(snapshotUrl);

      if (!response.ok) {
        throw new Error(`Snapshot API error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.results) {
        throw new Error('No snapshot data available');
      }

      console.log(`Analyzing ${Math.min(data.results.length, 100)} symbols from market snapshot...`);

      const qualifyingStocks: GapStock[] = [];

      // Check symbols that show significant change
      const candidateSymbols = data.results
        .filter((ticker: any) =>
          ticker.todaysChangePerc &&
          Math.abs(ticker.todaysChangePerc) >= 15 && // At least 15% change
          ticker.day?.v >= this.config.gapCriteria.minCumulativeVolume // Use config-based volume filter
        )
        .slice(0, 50) // Limit to 50 candidates
        .map((ticker: any) => ticker.ticker);

      for (const symbol of candidateSymbols) {
        try {
          const gapStock = await this.analyzeStockForGap(symbol, date);
          if (gapStock) {
            qualifyingStocks.push(gapStock);
          }
        } catch (error) {
          console.warn(`Error analyzing snapshot symbol ${symbol}:`, error);
        }

        // Small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      return qualifyingStocks;

    } catch (error) {
      console.error('Error with snapshot approach:', error);
      throw error;
    }
  }

  // Analyze individual stock using 15-minute bars to check gap and volume
  private async analyzeStockForGap(symbol: string, date: string): Promise<GapStock | null> {
    try {
      // Get previous day for comparison - using proper date parsing
      const [year, month, day] = date.split('-').map(Number);
      const currentDate = new Date(year, month - 1, day); // month is 0-indexed
      const yesterday = new Date(currentDate.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

      // Get previous day's close price
      const prevCloseUrl = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${yesterdayStr}/${yesterdayStr}?adjusted=true&apikey=${this.polygonApiKey}`;
      const prevCloseResponse = await fetch(prevCloseUrl);

      if (!prevCloseResponse.ok) {
        return null;
      }

      const prevCloseData: PolygonAggregatesResponse = await prevCloseResponse.json();

      if (!prevCloseData.results || prevCloseData.results.length === 0) {
        return null;
      }

      const previousClose = prevCloseData.results[0].c;

      // Get 15-minute bars for today's pre-market (4:00-9:30 AM ET)
      const barsUrl = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/15/minute/${date}/${date}?adjusted=true&sort=asc&apikey=${this.polygonApiKey}`;
      const barsResponse = await fetch(barsUrl);

      if (!barsResponse.ok) {
        return null;
      }

      const barsData: PolygonAggregatesResponse = await barsResponse.json();

      if (!barsData.results || barsData.results.length === 0) {
        return null;
      }

      // Filter to configured market hours (supports both premarket-only and extended hours)
      const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);
      const [endHour, endMin] = this.config.marketHours.endTime.split(':').map(Number);
      const startTimeInHours = startHour + startMin / 60;
      const endTimeInHours = endHour + endMin / 60;

      const marketHoursBars = barsData.results.filter(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= startTimeInHours && etHour < endTimeInHours;
      });

      console.log(`📊 Filtered ${marketHoursBars.length} bars for configured hours (${this.config.marketHours.startTime}-${this.config.marketHours.endTime}) from ${barsData.results.length} total bars`);

      if (marketHoursBars.length === 0) {
        return null;
      }

      // Calculate metrics
      const currentPrice = marketHoursBars[marketHoursBars.length - 1].c;
      const hod = await this.getExtendedHOD(symbol, marketHoursBars);
      const totalVolume = marketHoursBars.reduce((sum, bar) => sum + bar.v, 0);
      const gapPercent = ((currentPrice - previousClose) / previousClose) * 100;

      // Calculate daily 200 EMA (only once per symbol per day)
      const ema200 = await this.getDailyEMA200(symbol, date);

      // Debug logging for all symbols being analyzed
      console.log(`📊 ${symbol}: ${gapPercent.toFixed(1)}% gap, ${(totalVolume / 1000).toFixed(0)}k volume, $${currentPrice.toFixed(2)}, ${marketHoursBars.length} bars (min vol required: ${this.config.gapCriteria.minCumulativeVolume / 1000}k)`);

      // Use configured criteria for gap, volume, and price filtering
      if (gapPercent >= this.config.gapCriteria.minGapPercentage &&
          totalVolume >= this.config.gapCriteria.minCumulativeVolume &&
          currentPrice >= this.config.gapCriteria.minPrice &&
          currentPrice <= this.config.gapCriteria.maxPrice) {
        console.log(`✅ ${symbol}: QUALIFIED - ${gapPercent.toFixed(1)}% gap, ${(totalVolume / 1000).toFixed(0)}k volume ≥ ${this.config.gapCriteria.minCumulativeVolume / 1000}k required, $${currentPrice.toFixed(2)}`);

        return {
          symbol,
          gapPercent,
          currentPrice,
          previousClose,
          volume: marketHoursBars[marketHoursBars.length - 1].v,
          cumulativeVolume: totalVolume,
          hod,
          lastUpdated: Date.now(),
          ema200
        };
      } else {
        const gapReason = gapPercent < this.config.gapCriteria.minGapPercentage ? `gap<${this.config.gapCriteria.minGapPercentage}%` : '';
        const volumeReason = totalVolume < this.config.gapCriteria.minCumulativeVolume ? `vol<${this.config.gapCriteria.minCumulativeVolume/1000}k` : '';
        const priceLowReason = currentPrice < this.config.gapCriteria.minPrice ? `price<$${this.config.gapCriteria.minPrice}` : '';
        const priceHighReason = currentPrice > this.config.gapCriteria.maxPrice ? `price>$${this.config.gapCriteria.maxPrice}` : '';
        const reasons = [gapReason, volumeReason, priceLowReason, priceHighReason].filter(r => r).join(', ');
        console.log(`❌ ${symbol}: REJECTED - ${gapPercent.toFixed(1)}% gap, ${(totalVolume / 1000).toFixed(0)}k volume < ${this.config.gapCriteria.minCumulativeVolume / 1000}k required (${reasons})`);
        return null;
      }

    } catch (error) {
      console.error(`Error analyzing ${symbol}:`, error);
      return null;
    }
  }

  // Get daily 200 EMA using Polygon's technical indicators endpoint
  private async getDailyEMA200(symbol: string, date: string): Promise<number | undefined> {
    try {
      // Get yesterday's date for the EMA calculation
      const yesterday = new Date(new Date(date).getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // Use Polygon's EMA endpoint for daily 200 EMA
      const emaUrl = `https://api.polygon.io/v1/indicators/ema/${symbol}?timestamp=${yesterday}&timespan=day&adjusted=true&window=200&series_type=close&order=desc&limit=1&apikey=${this.polygonApiKey}`;

      const response = await fetch(emaUrl);

      if (!response.ok) {
        console.warn(`EMA API error for ${symbol}: ${response.status}`);
        return undefined;
      }

      const data = await response.json();

      if (data.status === 'OK' && data.results?.values && data.results.values.length > 0) {
        const ema200Value = data.results.values[0].value;
        console.log(`📈 ${symbol}: 200 EMA = $${ema200Value.toFixed(2)}`);
        return ema200Value;
      } else {
        console.warn(`No EMA data available for ${symbol}`);
        return undefined;
      }

    } catch (error) {
      console.error(`Error fetching EMA200 for ${symbol}:`, error);
      return undefined;
    }
  }

  private generateAlertDetail(stock: GapStock): string {
    const patterns = [
      `${(50 + Math.random() * 30).toFixed(0)}% upper wick, red close`,
      `Broke HOD ${stock.hod.toFixed(2)}, closed under at ${stock.currentPrice.toFixed(2)}`,
      `New low near HOD, ${stock.gapPercent.toFixed(1)}% gap`,
      `Volume: ${(stock.volume / 1000).toFixed(0)}k, Gap: ${stock.gapPercent.toFixed(1)}%`
    ];
    return patterns[Math.floor(Math.random() * patterns.length)];
  }
}