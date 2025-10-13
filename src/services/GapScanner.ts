// Gap Scanner Service - Real gap stock detection with volume criteria
import { Alert, PatternType, SymbolData } from '../types';
import { getScannerConfig, validateScannerConfig, ScannerConfig } from '../config/scannerConfig';
import { WebSocketScanner } from './WebSocketScanner';

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
  private webSocketScanner: WebSocketScanner | null = null;
  private useWebSocket: boolean = true; // Enable WebSocket for real-time scanning

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

    // Initialize WebSocket scanner with pattern detection methods
    if (this.useWebSocket && this.polygonApiKey) {
      this.webSocketScanner = new WebSocketScanner(
        this.polygonApiKey,
        this.config,
        {
          detectToppingTail5m: this.detectToppingTail5m.bind(this),
          detectGreenRunReject: this.detectGreenRunReject.bind(this)
        }
      );
      console.log('✅ WebSocket scanner initialized');
    }
  }

  // Clear API response cache - needed when configuration changes
  private clearCache(): void {
    console.log('🗑️ Clearing API response cache to respect updated configuration');
    this.requestCache.clear();
    this.requestQueue.clear();
    // Also clear fired alert IDs to allow re-detection with new time filters
    this.firedAlertIds.clear();
    console.log('✅ Cache cleared successfully');
  }

  // Validate and apply configuration
  private validateAndApplyConfig(): void {
    const configErrors = validateScannerConfig(this.config);
    if (configErrors.length > 0) {
      console.error('Scanner Configuration Errors:', configErrors);
      throw new Error(`Invalid scanner configuration: ${configErrors.join(', ')}`);
    }

    console.log(`🔧 Scanner Config Applied: Hours ${this.config.marketHours.startTime}-${this.config.marketHours.endTime} ET`);

    // Clear cache to ensure fresh data with updated configuration
    this.clearCache();

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

  // Check if current time is within configured market hours (with 2-minute grace period)
  private isWithinMarketHours(now?: Date): boolean {
    const currentTime = now || this.getCurrentTime();

    // Get ET time components properly
    const etTime = new Date(currentTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const etHour = etTime.getHours();
    const etMinutes = etTime.getMinutes();

    const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);
    const [endHour, endMin] = this.config.marketHours.endTime.split(':').map(Number);

    const startTimeInMinutes = startHour * 60 + startMin;
    const endTimeInMinutes = endHour * 60 + endMin;
    const currentTimeInMinutes = etHour * 60 + etMinutes;

    // Add 2-minute grace period before market start to avoid missing first bars
    const graceStartTime = startTimeInMinutes - 2;
    const isWithin = currentTimeInMinutes >= graceStartTime && currentTimeInMinutes < endTimeInMinutes;

    // Log ET wall-clock time on each check
    console.log(`⏰ ET Time: ${etHour.toString().padStart(2, '0')}:${etMinutes.toString().padStart(2, '0')} | Market: ${startHour}:${startMin.toString().padStart(2, '0')}-${endHour}:${endMin.toString().padStart(2, '0')} | Status: ${isWithin ? 'ACTIVE (incl. 2min grace)' : 'CLOSED'}`);

    if (this.config.development.enableDebugLogging) {
      console.log(`⏰ Market Hours Check: ${etHour.toString().padStart(2, '0')}:${etMinutes.toString().padStart(2, '0')} ET (${currentTimeInMinutes} min) vs ${startHour}:${startMin.toString().padStart(2, '0')}-${endHour}:${endMin.toString().padStart(2, '0')} (${graceStartTime}-${endTimeInMinutes} min w/ grace) = ${isWithin ? 'WITHIN' : 'OUTSIDE'}`);
    }

    return isWithin;
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
      console.log(`\n========== SCANNER MODE SELECTION ==========`);
      console.log(`Current ET Time: ${this.formatETTime(now)} (Hour: ${etHour.toFixed(2)})`);
      console.log(`Config: ${this.config.gapCriteria.minGapPercentage}%+ gap, ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K+ volume, $${this.config.gapCriteria.minPrice}-${this.config.gapCriteria.maxPrice} price`);
      console.log(`Market Hours: ${this.config.marketHours.startTime} - ${this.config.marketHours.endTime} ET`);

      const withinMarketHours = this.isWithinMarketHours(now);
      console.log(`Within Market Hours Check: ${withinMarketHours}`);
      console.log(`ET Hour >= 9.5 (9:30 AM)?: ${etHour >= 9.5}`);

      // Use live premarket analysis before 9:30 AM with minute bar volume
      // Use live gainers endpoint during regular hours (after 9:30 AM)
      if (etHour >= 9.5) {
        console.log('📈 MODE: REGULAR HOURS - Using live gainers endpoint');
        console.log(`============================================\n`);
        const qualifyingStocks = await this.fetchLiveGappers(today);
        console.log(`Found ${qualifyingStocks.length} qualifying gap stocks:`, qualifyingStocks.map(s => s.symbol));
        return qualifyingStocks;
      } else if (withinMarketHours) {
        console.log('🌅 MODE: PREMARKET - Using live premarket scan with minute bar volume');
        console.log(`============================================\n`);
        const qualifyingStocks = await this.fetchLivePremarketGappers(today);
        console.log(`Found ${qualifyingStocks.length} premarket gap stocks:`, qualifyingStocks.map(s => s.symbol));
        return qualifyingStocks;
      } else {
        console.log('🕐 MODE: MARKET CLOSED - Using historical analysis');
        console.log(`============================================\n`);
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
        const changePerc = ticker.todaysChangePerc;    // todaysChangePerc (gap percentage)
        const tickerSymbol = ticker.ticker;            // ticker symbol
        const previousClose = ticker.prevDay?.c;       // Previous day close for gap calculation

        // Use min.av as the volume metric (this represents cumulative volume)
        const avgVolume = ticker.min?.av;              // min.av (cumulative average volume)

        // Enhanced debug logging to understand volume data
        if (this.config.development.enableDebugLogging && tickerSymbol) {
          console.log(`🔍 VOLUME DEBUG ${tickerSymbol}: min.av=${avgVolume || 'N/A'}, day.v=${ticker.day?.v || 'N/A'}, required=${this.config.gapCriteria.minCumulativeVolume}`);
        }

        if (!lastPrice || !avgVolume || !changePerc || !tickerSymbol || !previousClose) {
          if (this.config.development.enableDebugLogging) {
            console.log(`❌ ${tickerSymbol}: MISSING DATA - price=${lastPrice}, volume=${avgVolume}, change=${changePerc}, prevClose=${previousClose}`);
          }
          continue; // Skip if missing required data
        }

        // Apply your specified criteria: $1-$10 price, >500k volume, >10% gap
        const priceInRange = lastPrice >= this.config.gapCriteria.minPrice && lastPrice <= this.config.gapCriteria.maxPrice;
        const volumeQualified = avgVolume >= this.config.gapCriteria.minCumulativeVolume;
        const gapQualified = changePerc >= this.config.gapCriteria.minGapPercentage;

        // Enhanced logging for volume filtering
        if (this.config.development.enableDebugLogging) {
          console.log(`📊 ${tickerSymbol} FILTER CHECK: price=${priceInRange ? '✅' : '❌'} (${lastPrice.toFixed(2)}), volume=${volumeQualified ? '✅' : '❌'} (${(avgVolume/1000).toFixed(0)}K >= ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K), gap=${gapQualified ? '✅' : '❌'} (${changePerc.toFixed(1)}%)`);
        }

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

  // Calculate accurate premarket volume from minute bars (configured start time to current time)
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

      // Sum up volume from all bars during configured market hours
      const totalPremarketVolume = bars.reduce((sum, bar) => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        // Only count bars in configured market hours
        if (etHour >= this.getConfigStartHour() && etHour < this.getConfigEndHour()) {
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

  // Calculate both premarket volume and HOD from extended-hours minute bars
  private async getPremarketVolumeAndHOD(symbol: string, date: string): Promise<{ volume: number; hod: number } | null> {
    try {
      // Get current time to determine end of premarket volume calculation
      const now = this.getCurrentTime();
      const marketStart = this.getMarketStartTime();
      const marketOpen = new Date(marketStart);
      marketOpen.setHours(9, 30, 0, 0); // 9:30 AM ET

      // Use current time if we're still in premarket, otherwise use market open
      const endTime = now < marketOpen ? now : marketOpen;

      console.log(`Calculating premarket volume and HOD for ${symbol} from ${this.formatETTime(marketStart)} to ${this.formatETTime(endTime)}`);

      // Get minute bars for the premarket period (with extended hours)
      const bars = await this.getHistoricalBars(symbol, marketStart, endTime);

      if (bars.length === 0) {
        console.warn(`No premarket bars found for ${symbol}`);
        return null;
      }

      // Calculate volume and HOD from extended-hours bars
      let totalPremarketVolume = 0;
      let premarketHOD = 0;

      bars.forEach(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        // Only count bars in configured market hours
        if (etHour >= this.getConfigStartHour() && etHour < this.getConfigEndHour()) {
          totalPremarketVolume += bar.v;
          if (bar.h > premarketHOD) {
            premarketHOD = bar.h;
          }
        }
      });

      console.log(`${symbol}: Calculated premarket volume = ${(totalPremarketVolume/1000).toFixed(0)}K, HOD = $${premarketHOD.toFixed(2)} from ${bars.length} minute bars`);

      return { volume: totalPremarketVolume, hod: premarketHOD };

    } catch (error) {
      console.error(`Error calculating premarket data for ${symbol}:`, error);
      return null;
    }
  }

  // Initialize or update pattern state for a symbol from historical bars
  private initializePatternState(symbol: string, bars: PolygonBar[]): void {
    if (bars.length === 0) return;

    // Progressive HOD calculation - track HOD as it develops chronologically
    let currentHOD = bars[0].h;
    let consecutiveGreen = 0;
    let lastBarWasGreen = false;
    let greenRunStartPrice: number | undefined;

    // Process bars in chronological order to build state
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];

      // Update HOD progressively as we encounter new highs
      if (bar.h > currentHOD) {
        currentHOD = bar.h;
        console.log(`📈 REAL-TIME HOD UPDATE: ${symbol} → ${currentHOD.toFixed(2)} at bar ${i}`);
      }

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
      hod: currentHOD,
      consecutiveGreenCandles: consecutiveGreen,
      lastBarWasGreen,
      greenRunStartPrice,
      lastAnalyzedBarTimestamp: lastBar.t
    });

    console.log(`Initialized pattern state for ${symbol}: HOD=${currentHOD.toFixed(2)}, ConsecGreen=${consecutiveGreen}, LastGreen=${lastBarWasGreen}`);
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

  // Fetch live premarket gappers with accurate volume from minute bars
  private async fetchLivePremarketGappers(today: string): Promise<GapStock[]> {
    console.log('🌅 LIVE PREMARKET SCAN: Fetching gappers with minute bar volume calculation');

    try {
      // First get potential gappers from the live snapshot
      const gainersUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apikey=${this.polygonApiKey}`;
      console.log('Fetching gainers from snapshot API...');
      const gainersData = await this.cachedFetch(gainersUrl);

      if (gainersData.status !== 'OK' || !gainersData.tickers) {
        console.error('❌ No real-time gainers data available');
        return [];
      }

      console.log(`✅ Found ${gainersData.tickers.length} total gainers`);

      // Filter for potential gap stocks (basic criteria)
      const candidates = gainersData.tickers.filter((ticker: any) => {
        const lastPrice = ticker.lastTrade?.p;
        const changePerc = ticker.todaysChangePerc;
        const prevClose = ticker.prevDay?.c;

        const meetsGap = changePerc >= this.config.gapCriteria.minGapPercentage;
        const meetsPrice = lastPrice >= this.config.gapCriteria.minPrice && lastPrice <= this.config.gapCriteria.maxPrice;

        if (meetsGap && meetsPrice) {
          console.log(`📊 Candidate: ${ticker.ticker} - ${changePerc?.toFixed(1)}% gap, $${lastPrice?.toFixed(2)}`);
        }

        return meetsGap && meetsPrice && lastPrice && prevClose;
      }).slice(0, 20); // Limit to top 20 candidates to avoid API rate limits

      console.log(`\n🎯 Found ${candidates.length} gap candidates meeting basic criteria (>=${this.config.gapCriteria.minGapPercentage}% gap, $${this.config.gapCriteria.minPrice}-${this.config.gapCriteria.maxPrice})\n`);

      if (candidates.length === 0) {
        console.log('❌ No candidates found. Consider lowering minGapPercentage or adjusting price range.');
        return [];
      }

      // Now calculate accurate premarket volume for each candidate
      const qualifyingStocks: GapStock[] = [];

      for (const ticker of candidates) {
        try {
          const symbol = ticker.ticker;
          const lastPrice = ticker.lastTrade.p;
          const changePerc = ticker.todaysChangePerc;
          const previousClose = ticker.prevDay.c;

          console.log(`\n🔍 Checking ${symbol} premarket volume and HOD...`);

          // Calculate premarket volume and HOD from extended-hours minute bars
          const premarketData = await this.getPremarketVolumeAndHOD(symbol, today);

          if (!premarketData) {
            console.log(`❌ ${symbol}: No premarket data available`);
            continue;
          }

          // Check if premarket volume meets criteria
          if (premarketData.volume >= this.config.gapCriteria.minCumulativeVolume) {
            console.log(`✅ ${symbol}: QUALIFIED - ${changePerc.toFixed(1)}% gap, ${(premarketData.volume/1000).toFixed(0)}K premarket volume, $${lastPrice.toFixed(2)}, HOD $${premarketData.hod.toFixed(2)}`);

            qualifyingStocks.push({
              symbol,
              gapPercent: changePerc,
              currentPrice: lastPrice,
              previousClose,
              volume: premarketData.volume,
              cumulativeVolume: premarketData.volume,
              hod: premarketData.hod, // Use premarket HOD from extended-hours bars
              lastUpdated: Date.now(),
              ema200: undefined
            });
          } else {
            console.log(`❌ ${symbol}: ${(premarketData.volume/1000).toFixed(0)}K premarket volume < ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K required`);
          }
        } catch (error) {
          console.error(`❌ Error processing ${ticker.ticker}:`, error);
        }
      }

      console.log(`\n✅ Found ${qualifyingStocks.length} qualifying premarket gap stocks\n`);
      return qualifyingStocks;

    } catch (error) {
      console.error('❌ Error fetching live premarket gappers:', error);
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
    const configStart = this.getConfigStartHour();
    const configEnd = this.getConfigEndHour();
    const isPremarket = etHour >= configStart && etHour < configEnd;
    const isRegularHours = etHour >= 9.5 && etHour < 16;
    const isAfterHours = etHour >= 16 || etHour < configStart;

    console.log(`📊 Session Analysis: Premarket=${isPremarket}, Regular=${isRegularHours}, After=${isAfterHours}, Current=${etHour.toFixed(2)}`);

    // Enhanced backfill logic with dynamic end time capping
    let endTime: number;
    let backfillReason: string;

    // Clamp backfill window: don't return early if before start, just clamp to max(now, start)
    if (!this.isWithinMarketHours(now) && now.getTime() < startTime.getTime()) {
      // Before grace period - clamp end time to current time
      endTime = Math.max(now.getTime(), startTime.getTime());
      backfillReason = 'Before market hours (clamped to start time)';

      if (this.config.development.enableDebugLogging) {
        console.log(`🕐 Before market hours - clamping backfill window to ${this.formatETTime(new Date(endTime))}`);
      }
    } else if (this.isWithinMarketHours(now)) {
      // During configured market hours: backfill from start time to current time
      endTime = now.getTime();
      backfillReason = `Market session active (${isPremarket ? 'premarket' : isRegularHours ? 'regular' : 'extended'})`;

      if (this.config.development.enableDebugLogging) {
        console.log(`🔴 LIVE BACKFILL: ${backfillReason} - backfilling from ${this.config.marketHours.startTime} to current time`);
      }
    } else {
      // After market hours: Apply dynamic capping logic
      // If current time is after 9:25 AM ET, cap the end time at 9:25 AM ET
      const capTime = this.getDynamicEndTime();
      endTime = Math.min(marketEnd.getTime(), capTime.getTime());
      backfillReason = `Market closed - capped session (${this.config.marketHours.startTime} - ${this.formatETTime(new Date(endTime))})`;

      if (this.config.development.enableDebugLogging) {
        console.log(`⏹️ COMPLETE BACKFILL: ${backfillReason}`);
        console.log(`🔒 Dynamic capping: Original end=${this.formatETTime(marketEnd)}, Capped end=${this.formatETTime(new Date(endTime))}`);
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

      // Filter alerts to only include those in our backfill time window with dynamic capping
      const filteredAlerts = backfilledAlerts.filter(alert => {
        const alertTime = new Date(alert.timestamp);
        const inTimeWindow = alert.timestamp >= startTime.getTime() && alert.timestamp <= endTime;

        if (this.config.development.enableDebugLogging && !inTimeWindow) {
          console.log(`⏰ FILTERING OUT ALERT: ${alert.symbol} at ${this.formatETTime(alertTime)} (outside dynamic window ${backfillStartTime} - ${backfillEndTime})`);
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
          return alertHour >= this.getConfigStartHour() && alertHour < this.getConfigEndHour();
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
  async startScanning(): Promise<void> {
    console.log(`\n${'*'.repeat(80)}`);
    console.log(`🚀 startScanning() called - Current state: isScanning=${this.isScanning}`);
    console.log(`${'*'.repeat(80)}`);

    if (this.isScanning) {
      console.log(`⚠️  Scanner is already running - ignoring duplicate start request`);
      return;
    }

    this.isScanning = true;
    console.log(`✅ isScanning flag set to TRUE`);
    console.log(`📋 Market Hours: ${this.config.marketHours.startTime} - ${this.config.marketHours.endTime} ET`);

    // Initial scan for gap stocks
    console.log(`📊 Performing initial gap stock scan...`);
    const gapStocks = await this.scanForGappers();

    // Check last 4 5-minute candles for existing patterns on startup
    console.log(`📜 Checking last 4 5-minute candles for patterns already in progress...`);
    await this.checkStartupHistoricalPatterns();

    // Check if we should use WebSocket (anytime app is running with qualifying stocks)
    const useWebSocketScanning = this.useWebSocket &&
                                  this.webSocketScanner &&
                                  gapStocks.length > 0;

    if (useWebSocketScanning) {
      console.log(`🔌 Using WEBSOCKET mode for real-time scanning`);
      console.log(`   Symbols: ${gapStocks.length}`);

      try {
        // Register alert callback with WebSocket scanner
        this.webSocketScanner!.onAlert((alert: Alert) => {
          console.log(`📨 WebSocket alert received: ${alert.symbol} ${alert.type}`);
          this.fireAlert(alert);
        });

        // Connect to WebSocket with current symbols
        const symbolsData = gapStocks.map(stock => ({
          symbol: stock.symbol,
          gapPercent: stock.gapPercent,
          previousClose: stock.previousClose,
          currentPrice: stock.currentPrice
        }));

        await this.webSocketScanner!.connect(symbolsData);
        console.log(`✅ WebSocket scanner connected and streaming`);

        // Set up periodic symbol list updates (every 2 minutes)
        this.scanInterval = window.setInterval(async () => {
          console.log(`\n🔄 Updating WebSocket watchlist...`);
          const updatedStocks = await this.scanForGappers();
          const updatedData = updatedStocks.map(stock => ({
            symbol: stock.symbol,
            gapPercent: stock.gapPercent,
            previousClose: stock.previousClose,
            currentPrice: stock.currentPrice
          }));
          await this.webSocketScanner!.updateSymbols(updatedData);
        }, 120000); // 2 minutes

      } catch (error) {
        console.error('❌ Failed to start WebSocket scanner:', error);
        console.log('⚠️  Falling back to polling mode...');
        // Fall back to polling
        this.scheduleNextBackfill();
      }

    } else {
      console.log(`📡 Using POLLING mode for scanning`);
      console.log(`   Reason: ${!this.useWebSocket ? 'WebSocket disabled' :
                                  !this.webSocketScanner ? 'No WebSocket scanner' :
                                  gapStocks.length === 0 ? 'No qualifying stocks' :
                                  'Outside regular hours'}`);

      // Start immediate backfill, then continue on interval
      console.log(`⏰ Scheduling first backfill run...`);
      this.scheduleNextBackfill();
    }

    console.log(`${'*'.repeat(80)}`);
    console.log(`✅ Scanner started successfully`);
    console.log(`${'*'.repeat(80)}\n`);
  }

  // Schedule backfill to run aligned with 5-minute candle boundaries
  private scheduleNextBackfill(): void {
    console.log(`📅 scheduleNextBackfill() - Setting up smart backfill scheduling`);
    console.log(`   Strategy: Aligned to 5-minute candle closes + 1 second delay`);

    // Perform initial backfill after short delay to let initialization complete
    const initialDelay = 2000; // 2 seconds
    console.log(`   Scheduling initial backfill in ${initialDelay}ms...`);
    setTimeout(() => {
      console.log(`⏰ Initial backfill delay complete - starting first scan now`);
      this.performScheduledBackfill();
    }, initialDelay);
  }

  // Calculate milliseconds until next 5-minute boundary + 1 second
  private getMillisecondsUntilNext5MinBoundary(): number {
    const now = new Date();
    const etTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));

    const currentMinutes = etTime.getMinutes();
    const currentSeconds = etTime.getSeconds();
    const currentMilliseconds = etTime.getMilliseconds();

    // Calculate minutes until next 5-minute boundary
    const minutesTo5MinBoundary = 5 - (currentMinutes % 5);
    const secondsUntilBoundary = minutesTo5MinBoundary === 5 && currentSeconds === 0 && currentMilliseconds === 0
      ? 0  // We're exactly at a boundary
      : (minutesTo5MinBoundary * 60) - currentSeconds;

    // Add 15 second delay after the boundary to ensure Polygon has published the completed candle
    // Polygon needs time to aggregate and publish 5-minute bar data after the candle closes
    const delayAfterBoundaryMs = 15000; // 15 seconds = 15000ms
    const msUntilBoundary = (secondsUntilBoundary * 1000) - currentMilliseconds;
    const msUntilScan = msUntilBoundary + delayAfterBoundaryMs;

    // If we're very close to a scan time, schedule for next boundary instead
    if (msUntilScan < 500) {
      return msUntilScan + (5 * 60 * 1000); // Add 5 minutes
    }

    return msUntilScan;
  }

  // Perform backfill on schedule
  private async performScheduledBackfill(): Promise<void> {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔄 performScheduledBackfill() START - isScanning=${this.isScanning}`);
    console.log(`${'='.repeat(80)}`);

    try {
      const now = this.getCurrentTime();

      // Check if we're within market hours, before, or after
      const startTime = this.getMarketStartTime();
      const endTime = this.getMarketEndTime();
      const isWithin = this.isWithinMarketHours(now);
      const isBeforeStart = now.getTime() < startTime.getTime();
      const isAfterEnd = now.getTime() >= endTime.getTime();

      if (isWithin) {
        // WITHIN MARKET HOURS - Perform backfill
        console.log(`✅ Within market hours - proceeding with backfill at ${this.formatETTime(now)}...`);
        if (this.config.development.enableDebugLogging) {
          console.log(`   Checking for new pattern signals since last scan`);
        }

        // Update gap stocks first
        console.log(`📊 Step 1: Updating gap stocks list...`);
        await this.scanForGappers();
        console.log(`   ✅ Gap stocks updated`);

        // Perform backfill to get latest signals
        console.log(`📊 Step 2: Performing continuous backfill...`);
        await this.performContinuousBackfill();
        console.log(`   ✅ Continuous backfill complete`);

        // Schedule next backfill aligned to next 5-minute boundary
        const msUntilNext = this.getMillisecondsUntilNext5MinBoundary();
        const nextScanTime = new Date(Date.now() + msUntilNext);
        const etNextScan = new Date(nextScanTime.toLocaleString("en-US", {timeZone: "America/New_York"}));

        console.log(`⏰ SCHEDULING NEXT SCAN: ${etNextScan.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})} ET (in ${(msUntilNext/1000).toFixed(0)}s)`);

        // Clear any existing timeout and schedule the next one
        if (this.scanInterval) {
          clearTimeout(this.scanInterval);
          console.log(`   🗑️  Cleared existing timeout`);
        }
        this.scanInterval = window.setTimeout(() => {
          console.log(`\n⏰ TIMEOUT FIRED - Executing scheduled backfill now`);
          this.performScheduledBackfill();
        }, msUntilNext);
        console.log(`   ✅ Next scan scheduled (timeout ID: ${this.scanInterval})`);

      } else if (isBeforeStart) {
        // BEFORE MARKET HOURS - Wait for market to open
        console.log(`⏰ BEFORE MARKET HOURS at ${this.formatETTime(now)} (market starts at ${this.formatETTime(startTime)})`);
        console.log(`   Waiting for market to open... will check again in 30 seconds`);

        // Schedule check in 30 seconds
        if (this.scanInterval) {
          clearTimeout(this.scanInterval);
        }
        this.scanInterval = window.setTimeout(() => {
          console.log(`\n⏰ PRE-MARKET CHECK - Checking if market hours have started`);
          this.performScheduledBackfill();
        }, 30000); // Check every 30 seconds
        console.log(`   ✅ Pre-market check scheduled (timeout ID: ${this.scanInterval})`);

      } else if (isAfterEnd) {
        // AFTER MARKET HOURS - Auto-stop scanner
        console.log(`❌ AFTER MARKET HOURS at ${this.formatETTime(now)} (market ended at ${this.formatETTime(endTime)})`);
        if (this.isScanning) {
          console.log(`🛑 Automatically stopping scanner...`);
          this.stopScanning();
        } else {
          console.log(`ℹ️  Scanner already stopped`);
        }
      }
    } catch (error) {
      console.error('❌ ERROR in scheduled backfill:', error);
      console.error('   Stack trace:', error);

      // Even on error, schedule next scan if still scanning and not after market hours
      const currentTime = this.getCurrentTime();
      const isAfterMarket = currentTime.getTime() >= this.getMarketEndTime().getTime();

      if (this.isScanning && !isAfterMarket) {
        const msUntilNext = this.isWithinMarketHours(currentTime)
          ? this.getMillisecondsUntilNext5MinBoundary()
          : 30000; // 30 seconds if before market

        console.log(`⚠️  RECOVERY: Scheduling next scan despite error (in ${(msUntilNext/1000).toFixed(0)}s)`);
        if (this.scanInterval) {
          clearTimeout(this.scanInterval);
        }
        this.scanInterval = window.setTimeout(() => {
          console.log(`\n⏰ RECOVERY TIMEOUT FIRED - Retrying backfill`);
          this.performScheduledBackfill();
        }, msUntilNext);
        console.log(`   ✅ Recovery scan scheduled (timeout ID: ${this.scanInterval})`);
      } else {
        console.log(`❌ NOT RESCHEDULING: isScanning=${this.isScanning}, isAfterMarket=${isAfterMarket}`);
      }
    }

    console.log(`${'='.repeat(80)}`);
    console.log(`🔄 performScheduledBackfill() END`);
    console.log(`${'='.repeat(80)}\n`);
  }

  // Check the last 4 5-minute candles on startup to detect patterns already in progress
  private async checkStartupHistoricalPatterns(): Promise<void> {
    try {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`📜 STARTUP HISTORICAL CHECK: Analyzing last 4 5-minute candles for existing patterns`);
      console.log(`${'='.repeat(80)}`);

      const gapStocksList = Array.from(this.gapStocks.values());
      if (gapStocksList.length === 0) {
        console.log('⏭️  No gap stocks to analyze');
        return;
      }

      const now = this.getCurrentTime();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      let totalPatternsFound = 0;

      // Analyze each gap stock
      for (const gapStock of gapStocksList) {
        try {
          console.log(`\n📊 Analyzing ${gapStock.symbol} for recent patterns...`);

          // Get 5-minute bars for today
          const bars5m = await this.get5MinuteBars(
            gapStock.symbol,
            todayStart,
            now
          );

          if (bars5m.length === 0) {
            console.log(`   ⏭️  No 5-minute bars found for ${gapStock.symbol}`);
            continue;
          }

          // Get the last 4 candles (or fewer if less than 4 are available)
          const last4Candles = bars5m.slice(-4);
          console.log(`   📊 Found ${bars5m.length} total bars, analyzing last ${last4Candles.length} candles`);

          // Get 1-minute bars for volume calculation
          const dateString = now.toISOString().split('T')[0];
          const bars1m = await this.getHistoricalMinuteBars(gapStock.symbol, dateString);

          // Calculate cumulative volume up to current time
          const configStart = this.getConfigStartHour();
          const configEnd = this.getConfigEndHour();

          let cumulativeVolume = 0;
          for (const bar1m of bars1m) {
            const etHour = this.getETHour(new Date(bar1m.t));
            if (etHour >= configStart && etHour < configEnd && bar1m.t <= now.getTime()) {
              cumulativeVolume += bar1m.v;
            }
          }

          console.log(`   📊 Cumulative volume: ${(cumulativeVolume / 1000).toFixed(0)}k`);

          // Calculate current HOD including pre-market
          let currentHOD = gapStock.hod; // Start with stored HOD

          // Check each of the last 4 candles for patterns
          for (let i = 0; i < last4Candles.length; i++) {
            const bar = last4Candles[i];
            const barIndex = bars5m.indexOf(bar);
            const timestamp = new Date(bar.t);

            console.log(`   🔍 Checking candle ${i + 1}/${last4Candles.length} at ${this.formatETTime(timestamp)}`);

            // Update HOD progressively
            if (bar.h > currentHOD) {
              currentHOD = bar.h;
              console.log(`      📈 Updated HOD: ${currentHOD.toFixed(2)}`);
            }

            // Run pattern detection
            const patterns = [
              this.detectToppingTail5m(gapStock.symbol, bars5m, barIndex, currentHOD, timestamp, cumulativeVolume, gapStock.gapPercent),
              this.detectGreenRunReject(gapStock.symbol, bars5m, barIndex, currentHOD, timestamp, cumulativeVolume, gapStock.gapPercent),
            ];

            // Fire any detected patterns
            patterns.forEach(alert => {
              if (alert) {
                console.log(`   🔔 STARTUP PATTERN FOUND: ${gapStock.symbol} ${alert.type} at ${this.formatETTime(new Date(alert.timestamp))}`);
                this.fireAlert(alert);
                totalPatternsFound++;
              }
            });
          }

        } catch (error) {
          console.warn(`   ⚠️  Failed to analyze ${gapStock.symbol}:`, error);
        }
      }

      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ STARTUP HISTORICAL CHECK COMPLETE: Found ${totalPatternsFound} patterns across ${gapStocksList.length} stocks`);
      console.log(`${'='.repeat(80)}\n`);

    } catch (error) {
      console.error('Error in startup historical pattern check:', error);
    }
  }

  // Perform continuous backfill and fire new alerts with sound notifications
  private async performContinuousBackfill(): Promise<void> {
    try {
      const now = Date.now();

      console.log(`🔍 Scanning for new signals (looking for alerts after ${new Date(this.lastBackfillTime).toLocaleTimeString()})...`);

      // Get the latest signals from backfill
      const backfilledAlerts = await this.backfillMissedData();
      console.log(`   📊 Backfill returned ${backfilledAlerts.length} total alerts`);

      // Find new alerts since last backfill
      const newAlerts = backfilledAlerts.filter(alert =>
        alert.timestamp > this.lastBackfillTime
      );

      if (newAlerts.length > 0) {
        console.log(`🔔 Found ${newAlerts.length} NEW signals from continuous backfill!`);
        console.log(`   Alert details: ${newAlerts.map(a => `${a.symbol} ${a.type} at ${new Date(a.timestamp).toLocaleTimeString()}`).join(', ')}`);

        // Fire each new alert through the callback system (triggers sound)
        newAlerts.forEach(alert => {
          this.fireAlert(alert);
        });
      } else {
        console.log(`✅ No new signals found (checked ${backfilledAlerts.length} alerts, all older than ${new Date(this.lastBackfillTime).toLocaleTimeString()})`);
      }

      // Update last backfill time
      this.lastBackfillTime = now;

    } catch (error) {
      console.error('Error in continuous backfill:', error);
    }
  }

  // Stop scanning
  stopScanning(): void {
    console.log(`🛑 stopScanning() called - Current state: isScanning=${this.isScanning}, hasInterval=${!!this.scanInterval}`);

    // Stop WebSocket scanner if running
    if (this.webSocketScanner && this.webSocketScanner.getConnectionStatus()) {
      console.log('   🔌 Disconnecting WebSocket scanner...');
      this.webSocketScanner.disconnect();
      console.log('   ✅ WebSocket scanner disconnected');
    }

    // Clear polling interval/timeout
    if (this.scanInterval) {
      clearTimeout(this.scanInterval);
      clearInterval(this.scanInterval); // Also try clearing as interval in case it was set that way
      this.scanInterval = null;
      console.log('   ✅ Cleared scheduled timeout/interval');
    }

    this.isScanning = false;
    console.log('   ✅ Gap stock scanner stopped');
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

  // Register alert callback - returns unsubscribe function
  onAlert(callback: (alert: Alert) => void): () => void {
    console.log(`📝 onAlert() - Registering new alert callback`);
    console.log(`   Callbacks before: ${this.alertCallbacks.length}`);
    this.alertCallbacks.push(callback);
    console.log(`   Callbacks after: ${this.alertCallbacks.length}`);
    console.log(`   ✅ Alert callback registered successfully`);

    // Return unsubscribe function
    return () => {
      const index = this.alertCallbacks.indexOf(callback);
      if (index > -1) {
        this.alertCallbacks.splice(index, 1);
        console.log(`🗑️  Alert callback removed (remaining: ${this.alertCallbacks.length})`);
      }
    };
  }

  // Public method to clear cache when configuration changes
  public invalidateCache(): void {
    this.clearCache();
    console.log('🔄 Cache invalidated - fresh data will be fetched on next scan');
  }

  // Set the last backfill time (used after initial load)
  public setLastBackfillTime(timestamp: number): void {
    this.lastBackfillTime = timestamp;
    console.log(`⏰ Last backfill time set to ${new Date(timestamp).toLocaleTimeString()}`);
  }

  // Fire alert to all callbacks with proper deduplication
  public fireAlert(alert: Alert): void {
    console.log(`\n🔔 fireAlert() called for ${alert.symbol} ${alert.type}`);
    console.log(`   Alert ID: ${alert.id}`);
    console.log(`   Alert Time: ${new Date(alert.timestamp).toLocaleTimeString()}`);
    console.log(`   Registered callbacks: ${this.alertCallbacks.length}`);
    console.log(`   Already fired? ${this.firedAlertIds.has(alert.id)}`);

    // Check if we've already fired this specific alert
    if (this.firedAlertIds.has(alert.id)) {
      console.log(`⏭️  SKIPPING: Alert already fired previously`);
      return; // Skip duplicate alert
    }

    // Mark alert as fired
    this.firedAlertIds.add(alert.id);
    console.log(`✅ Alert marked as fired (total fired: ${this.firedAlertIds.size})`);

    // Clean up old alert IDs to prevent memory leak (keep last 1000)
    if (this.firedAlertIds.size > 1000) {
      const alertIds = Array.from(this.firedAlertIds);
      const oldIds = alertIds.slice(0, alertIds.length - 500); // Remove oldest 500
      oldIds.forEach(id => this.firedAlertIds.delete(id));
      console.log(`🗑️  Cleaned up ${oldIds.length} old alert IDs`);
    }

    console.log(`🔔 FIRING ALERT to ${this.alertCallbacks.length} callback(s)...`);

    // Fire alert to all callbacks
    this.alertCallbacks.forEach((callback, index) => {
      try {
        console.log(`   📞 Calling callback ${index + 1}...`);
        callback(alert);
        console.log(`   ✅ Callback ${index + 1} completed successfully`);
      } catch (error) {
        console.error(`   ❌ ERROR in callback ${index + 1}:`, error);
      }
    });

    if (this.alertCallbacks.length === 0) {
      console.warn(`⚠️  WARNING: No callbacks registered! Alert will not be delivered to UI.`);
    }

    console.log(`🔔 fireAlert() complete\n`);
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

      // OPTIMIZATION: If scanning TODAY during market hours, use current gap stocks instead of re-fetching
      const now = this.getCurrentTime();
      const etNowForDate = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
      const todayDateString = `${etNowForDate.getFullYear()}-${String(etNowForDate.getMonth() + 1).padStart(2, '0')}-${String(etNowForDate.getDate()).padStart(2, '0')}`;
      const isToday = dateString === todayDateString;
      const isWithinHours = this.isWithinMarketHours(now);

      let historicalGapStocks: GapStock[];

      if (isToday && isWithinHours && this.gapStocks.size > 0) {
        // Use current gap stocks list (already populated by scanForGappers)
        historicalGapStocks = Array.from(this.gapStocks.values());
        console.log(`✅ Using CURRENT gap stocks list (${historicalGapStocks.length} stocks) - scanning TODAY during market hours`);
      } else {
        // Fetch historical gap stocks for past dates or when market is closed
        historicalGapStocks = await this.getHistoricalGapStocks(dateString);
        console.log(`📊 Fetched HISTORICAL gap stocks (${historicalGapStocks.length} stocks) - scanning ${isToday ? 'TODAY after hours' : 'past date'}`);
      }

      if (historicalGapStocks.length === 0) {
        console.log('No qualifying gap stocks found for this date');
        return [];
      }

      console.log(`Step 2: Found ${historicalGapStocks.length} qualifying gap stocks:`, historicalGapStocks.map(s => `${s.symbol} (${s.gapPercent.toFixed(1)}%, ${(s.cumulativeVolume/1000).toFixed(0)}k vol, $${s.currentPrice.toFixed(2)})`));

      // Get alerts for each gap stock during configured market hours
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

      // Find qualifying gap stocks (common stocks only)
      const qualifyingStocks: GapStock[] = [];

      for (const bar of groupedData.results) {
        if (!bar.T || !bar.o) continue; // Skip invalid data

        const symbol = bar.T;
        const previousClose = prevCloses.get(symbol);

        if (!previousClose) continue;

        const gapPercent = ((bar.o - previousClose) / previousClose) * 100;

        // Use average volume (vw = volume weighted average price, or check for different volume fields)
        // For gap stock discovery, we'll focus on gap percentage and price range rather than volume
        // since we want to find stocks that had good premarket setups regardless of total daily volume
        const avgVolume = bar.av || bar.vw || 0; // Try to get average volume if available

        // Filter for our criteria using configuration
        // Primary filter: gap percentage and price range (volume checked later during pattern analysis)
        if (gapPercent >= this.config.gapCriteria.minGapPercentage &&
            bar.o >= this.config.gapCriteria.minPrice &&
            bar.o <= this.config.gapCriteria.maxPrice) {

          // Check if it's a common stock (type: "CS")
          const isCommonStock = await this.isCommonStock(symbol, dateString);
          if (!isCommonStock) {
            console.log(`🚫 FILTERED OUT: ${symbol} - Not a common stock`);
            continue;
          }

          qualifyingStocks.push({
            symbol,
            gapPercent,
            currentPrice: bar.c,
            previousClose,
            volume: avgVolume, // Use average volume instead of total volume
            cumulativeVolume: 0, // Will be calculated during intraday analysis
            hod: bar.h,
            lastUpdated: Date.now(),
          });
        }
      }

      console.log(`Found ${qualifyingStocks.length} qualifying historical gap stocks`);

      // Sort by gap percentage (descending) to prioritize the biggest gaps, then take top N for performance
      const sortedStocks = qualifyingStocks
        .sort((a, b) => Math.abs(b.gapPercent) - Math.abs(a.gapPercent))
        .slice(0, this.config.historical.maxSymbolsToAnalyze);

      console.log(`Analyzing top ${sortedStocks.length} stocks by gap size:`,
        sortedStocks.slice(0, 10).map(s => `${s.symbol}(${s.gapPercent.toFixed(1)}% gap, $${s.currentPrice.toFixed(2)})`));

      return sortedStocks;

    } catch (error) {
      console.error('Failed to fetch historical gap stocks:', error);
      throw error;
    }
  }

  // Check if a ticker is a common stock (type: "CS")
  private async isCommonStock(symbol: string, dateString: string): Promise<boolean> {
    if (!this.polygonApiKey) {
      console.warn(`No Polygon API key - cannot verify ticker type for ${symbol}`);
      return true; // Default to allowing if we can't check
    }

    try {
      // Use v3 ticker details endpoint to get ticker information
      const url = `https://api.polygon.io/v3/reference/tickers/${symbol}?date=${dateString}&apikey=${this.polygonApiKey}`;

      const response = await fetch(url);

      if (!response.ok) {
        console.warn(`Failed to fetch ticker details for ${symbol}: ${response.status}`);
        return true; // Default to allowing if we can't check
      }

      const data = await response.json();

      if (data.results && data.results.type) {
        const tickerType = data.results.type;
        const isCS = tickerType === 'CS';

        if (!isCS) {
          console.log(`📋 ${symbol} ticker type: ${tickerType} (not CS)`);
        }

        return isCS;
      }

      // If no type info, default to allowing
      return true;

    } catch (error) {
      console.warn(`Error checking ticker type for ${symbol}:`, error);
      return true; // Default to allowing on error
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
      // Get both 1-minute and 5-minute bars for pattern detection
      const bars1m = await this.getHistoricalMinuteBars(symbol, dateString);
      const bars5m = await this.get5MinuteBars(
        symbol,
        new Date(dateString + 'T00:00:00'),
        new Date(dateString + 'T23:59:59')
      );

      if (bars1m.length === 0) {
        return [];
      }

      console.log(`📊 ${symbol} - Fetched ${bars1m.length} 1-minute bars and ${bars5m.length} 5-minute bars`);

      // Calculate cumulative volume progressively for each bar (up to signal time)
      const configStart = this.getConfigStartHour();
      const configEnd = this.getConfigEndHour();

      // Filter 1-minute bars to only those within market hours for volume calculation
      const marketHoursBars = bars1m.filter(bar => {
        const timestamp = new Date(bar.t);
        const etHour = this.getETHour(timestamp);
        return etHour >= configStart && etHour < configEnd;
      });

      // Calculate total session volume for initial safety check
      const totalSessionVolume = marketHoursBars.reduce((sum, bar) => sum + bar.v, 0);

      // INITIAL SAFETY CHECK: Ensure total session volume meets minimum requirements
      if (totalSessionVolume < this.config.gapCriteria.minCumulativeVolume) {
        console.error(`🚨 HISTORICAL VOLUME SAFETY FILTER: ${symbol} has ${(totalSessionVolume/1000).toFixed(0)}k total session volume < ${this.config.gapCriteria.minCumulativeVolume/1000}k required - BLOCKING ALL HISTORICAL PATTERNS`);
        return [];
      } else {
        console.log(`✅ ${symbol} HISTORICAL VOLUME OK: ${(totalSessionVolume/1000).toFixed(0)}k total session volume ≥ ${this.config.gapCriteria.minCumulativeVolume/1000}k required`);
      }

      const alerts: Alert[] = [];

      // Get extended HOD including previous day's post-market (4-8 PM) high
      const previousDate = this.getPreviousTradingDay(dateString);
      const afterHoursBars = await this.getAfterHoursBars(symbol, previousDate);
      const afterHoursHOD = afterHoursBars.length > 0 ? Math.max(...afterHoursBars.map(bar => bar.h)) : 0;

      // CRITICAL FIX: Calculate HOD from ALL pre-market data (before configured start time)
      // This includes both previous day post-market AND current day pre-market
      let premarketHOD = afterHoursHOD; // Start with previous day's post-market high

      // Find the maximum high from all bars BEFORE the configured start time
      for (const bar of bars1m) {
        const timestamp = new Date(bar.t);
        const etHour = this.getETHour(timestamp);

        // If this bar is before the configured start time, consider it for pre-market HOD
        if (etHour < configStart) {
          if (bar.h > premarketHOD) {
            premarketHOD = bar.h;
          }
        }
      }

      // Also check 5-minute bars for pre-market high
      for (const bar of bars5m) {
        const timestamp = new Date(bar.t);
        const etHour = this.getETHour(timestamp);

        if (etHour < configStart) {
          if (bar.h > premarketHOD) {
            premarketHOD = bar.h;
          }
        }
      }

      // Start with the pre-market HOD (includes previous day post-market + current day pre-market)
      let currentHOD = premarketHOD;

      console.log(`📈 ${symbol} Starting HOD: $${currentHOD.toFixed(2)} (prev day post-market: $${afterHoursHOD.toFixed(2)}, pre-market high: $${premarketHOD.toFixed(2)})`);

      // Progressive HOD tracking: Track HOD progressively as bars are processed chronologically.
      // This ensures we detect EVERY legitimate HOD break that occurred during the session,
      // not just the final one. Each break is evaluated against the HOD that existed at
      // that moment in time, providing accurate signal detection and backtesting results.

      // Build a cumulative volume map from 1-minute bars for accurate volume tracking
      const volumeMap = new Map<number, number>(); // timestamp -> cumulative volume
      let cumulativeVolume = 0;

      for (const bar1m of bars1m) {
        const etHour = this.getETHour(new Date(bar1m.t));
        if (etHour >= configStart && etHour < configEnd) {
          cumulativeVolume += bar1m.v;
          volumeMap.set(bar1m.t, cumulativeVolume);

          // Update HOD from 1-minute bars as well to catch intrabar highs
          if (bar1m.h > currentHOD) {
            const previousHOD = currentHOD;
            currentHOD = bar1m.h;
            console.log(`📈 NEW HOD (1m): ${symbol} ${previousHOD.toFixed(2)} → ${currentHOD.toFixed(2)} at ${this.formatETTime(new Date(bar1m.t))}`);
          }
        }
      }

      // Scan 5-minute bars for 5-minute patterns
      for (let index = 0; index < bars5m.length; index++) {
        const bar = bars5m[index];
        const timestamp = new Date(bar.t);

        // Skip if outside configured market hours
        const etHour = this.getETHour(timestamp);
        const configStart = this.getConfigStartHour();
        const configEnd = this.getConfigEndHour();

        if (etHour < configStart || etHour >= configEnd) {
          console.log(`⏰ FILTERED OUT: ${symbol} bar at ${this.formatETTime(timestamp)} (ET ${etHour.toFixed(2)}) - outside ${configStart.toFixed(1)}-${configEnd.toFixed(1)} hours`);
          continue;
        }

        // Get cumulative volume up to this 5-minute bar's end time
        // Find the closest 1-minute bar timestamp
        let cumulativeVolumeUpToNow = 0;
        for (const [ts, vol] of Array.from(volumeMap.entries())) {
          if (ts <= bar.t) {
            cumulativeVolumeUpToNow = vol;
          } else {
            break;
          }
        }

        // Update HOD progressively from 5-minute bars (should match 1m HOD but check anyway)
        if (bar.h > currentHOD) {
          const previousHOD = currentHOD;
          currentHOD = bar.h;
          console.log(`📈 NEW HOD (5m): ${symbol} ${previousHOD.toFixed(2)} → ${currentHOD.toFixed(2)} at ${this.formatETTime(timestamp)}`);
        }

        // Enhanced debug logging for bars within time range
        if (etHour >= 9.3) {
          console.log(`⚠️ PROCESSING LATE BAR: ${symbol} at ${this.formatETTime(timestamp)} (ET ${etHour.toFixed(2)}) - within config but near end time`);
        }

        // CRITICAL VOLUME CHECK: Verify cumulative volume up to this signal time meets requirements
        if (cumulativeVolumeUpToNow < this.config.gapCriteria.minCumulativeVolume) {
          console.log(`🚫 VOLUME FILTER: ${symbol} at ${this.formatETTime(timestamp)} - cumulative volume ${(cumulativeVolumeUpToNow/1000).toFixed(1)}K < ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K required - SKIPPING SIGNAL`);
          continue; // Skip this bar - insufficient volume up to this point
        } else {
          console.log(`✅ VOLUME PASSED: ${symbol} at ${this.formatETTime(timestamp)} - cumulative volume ${(cumulativeVolumeUpToNow/1000).toFixed(1)}K >= ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K required`);
        }

        // VOLUME VALIDATION: Check for unrealistic volume numbers
        if (cumulativeVolumeUpToNow > 10000000) { // 10M shares seems unrealistic for premarket
          console.warn(`⚠️ UNREALISTIC VOLUME WARNING: ${symbol} at ${this.formatETTime(timestamp)} has ${(cumulativeVolumeUpToNow/1000000).toFixed(1)}M cumulative volume - this may indicate a data error`);
        }

        // Check 5-minute patterns using native 5-minute bars
        // Use bar.t directly for timestamp to ensure consistency with filtering
        const barTimestamp = new Date(bar.t);
        const patterns = [
          this.detectToppingTail5m(symbol, bars5m, index, currentHOD, barTimestamp, cumulativeVolumeUpToNow, gapPercent),
          this.detectGreenRunReject(symbol, bars5m, index, currentHOD, barTimestamp, cumulativeVolumeUpToNow, gapPercent),
        ];


        patterns.forEach(alert => {
          if (alert) {
            const alertTime = new Date(alert.timestamp);
            const alertETHour = this.getETHour(alertTime);
            console.log(`📍 HISTORICAL ALERT GENERATED: ${symbol} ${alert.type} at ${this.formatETTime(alertTime)} (ET ${alertETHour.toFixed(2)})`);
            console.log(`   📊 Volume Details: Signal volume=${(cumulativeVolumeUpToNow/1000).toFixed(1)}k (up to signal time), Total session=${(totalSessionVolume/1000).toFixed(1)}k, Required=${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}k`);
            console.log(`   🎯 Volume Source: Cumulative from 6:30 AM to ${this.formatETTime(alertTime)} = ${cumulativeVolumeUpToNow.toLocaleString()} shares`);
            alerts.push(alert);
          }
        });
      }

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
      const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${dateString}/${dateString}?adjusted=true&sort=asc&limit=${this.config.api.aggregatesLimit}&include_extended_hours=true&apikey=${this.polygonApiKey}`;

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
    const etHour = etTime.getHours() + etTime.getMinutes() / 60;

    // Debug logging for time filtering issue
    if (etHour > 9.5 || etHour < 7) {
      console.log(`🕐 Time conversion: ${date.toISOString()} -> ET: ${etTime.toISOString()} -> Hour: ${etHour.toFixed(2)}`);
    }

    return etHour;
  }

  private getConfigStartHour(): number {
    const [hours, minutes] = this.config.marketHours.startTime.split(':').map(Number);
    return hours + minutes / 60;
  }

  private getConfigEndHour(): number {
    const [hours, minutes] = this.config.marketHours.endTime.split(':').map(Number);
    return hours + minutes / 60;
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

  // Get dynamic end time - caps at 9:25 AM ET if current time is after 9:25 AM ET
  private getDynamicEndTime(): Date {
    const now = this.getCurrentTime();

    // Create 9:25 AM ET for today
    const etTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const ninetwentyfiveET = new Date(etTime.getFullYear(), etTime.getMonth(), etTime.getDate(), 9, 25, 0);

    // Convert from ET back to local timezone
    const utcOffset = now.getTimezoneOffset() * 60000;
    const etOffset = ninetwentyfiveET.getTimezoneOffset() * 60000;
    const ninetwentyfiveLocal = new Date(ninetwentyfiveET.getTime() + etOffset - utcOffset);

    // Get current ET hour for comparison
    const currentETHour = this.getETHour(now);

    if (this.config.development.enableDebugLogging) {
      console.log(`🕘 Dynamic End Time Check: Current ET ${currentETHour.toFixed(2)} vs 9.42 (9:25 AM)`);
      console.log(`🕘 Current time: ${this.formatETTime(now)}, 9:25 AM ET: ${this.formatETTime(ninetwentyfiveLocal)}`);
    }

    // If current time is after 9:25 AM ET (9.42 hours), cap at 9:25 AM ET
    if (currentETHour > 9.42) {
      if (this.config.development.enableDebugLogging) {
        console.log(`🔒 CAPPING: Current time ${this.formatETTime(now)} is after 9:25 AM ET, capping end time`);
      }
      return ninetwentyfiveLocal;
    } else {
      if (this.config.development.enableDebugLogging) {
        console.log(`⏰ NO CAPPING: Current time ${this.formatETTime(now)} is before 9:25 AM ET, using current time`);
      }
      return now;
    }
  }

  // Calculate extended HOD including previous day after-hours (4:00-8:00 PM) + current configured market hours
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
  // Fetch 5-minute aggregates directly from Polygon
  private async get5MinuteBars(symbol: string, startTime: Date, endTime: Date): Promise<PolygonBar[]> {
    const startDate = startTime.toISOString().split('T')[0]; // YYYY-MM-DD
    const endDate = endTime.toISOString().split('T')[0];

    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/5/minute/${startDate}/${endDate}?adjusted=true&sort=asc&limit=${this.config.api.aggregatesLimit}&include_extended_hours=true&apikey=${this.polygonApiKey}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: PolygonAggregatesResponse = await response.json();

      if (data.status !== 'OK' || !data.results) {
        console.warn(`No 5-minute data for ${symbol}:`, data);
        return [];
      }

      // Filter bars to only include configured market hours
      const configStart = this.getConfigStartHour();
      const configEnd = this.getConfigEndHour();

      const filteredBars = data.results.filter(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= configStart && etHour < configEnd;
      });

      return filteredBars;
    } catch (error) {
      console.error(`Error fetching 5-minute bars for ${symbol}:`, error);
      return [];
    }
  }

  private async getHistoricalBars(symbol: string, startTime: Date, endTime: Date): Promise<PolygonBar[]> {
    const startDate = startTime.toISOString().split('T')[0]; // YYYY-MM-DD
    const endDate = endTime.toISOString().split('T')[0];

    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${startDate}/${endDate}?adjusted=true&sort=asc&limit=${this.config.api.aggregatesLimit}&include_extended_hours=true&apikey=${this.polygonApiKey}`;

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
      const configStart = this.getConfigStartHour();
      const configEnd = this.getConfigEndHour();

      const filteredBars = data.results.filter(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= configStart && etHour < configEnd;
      });

      console.log(`Retrieved ${filteredBars.length} 1-minute bars for ${symbol}`);
      return filteredBars;

    } catch (error) {
      console.error(`Error fetching data for ${symbol}:`, error);
      return [];
    }
  }


  // Pattern detection methods

  private detectToppingTail5m(symbol: string, bars5m: PolygonBar[], index: number, hod: number, timestamp: Date, cumulativeVolume?: number, gapPercent?: number): Alert | null {
    // bars5m are native 5-minute bars from Polygon - no aggregation needed!
    const bar = bars5m[index];

    // TOPPING TAIL DEFINITION:
    // A 5-minute candle that breaks HOD, gets rejected, and closes with a long upper wick
    //
    // VALIDATION CHECKS (in order):
    // 1. HOD Break: Candle high must break/touch HOD (or be within X% if loose mode)
    // 2. Close Proximity to HOD: Close must be within Y% below HOD (ensures rejection near top)
    // 3. Color Requirement: Must close red if mustCloseRed=true (optional)
    // 4. Upper Shadow: Must have significant upper wick (shadow ≥ ratio × body)
    // 5. Close Position: Must close at least X% down from candle high (rejection strength)
    // 6. Volume: Must meet minimum volume requirement

    console.log(`🔍 ${symbol} at ${this.formatETTime(timestamp)} - Checking topping tail: bar.h=${bar.h.toFixed(2)}, HOD=${hod.toFixed(2)}, bar.c=${bar.c.toFixed(2)}`);

    // CHECK 1: HOD proximity check (strict or loose based on config)
    const requireStrictBreak = this.config.patterns.toppingTail5m.requireStrictHODBreak;
    const maxHighDistance = this.config.patterns.toppingTail5m.maxHighDistanceFromHODPercent;

    if (requireStrictBreak) {
      // STRICT: Candle HIGH must touch or break HOD
      if (bar.h < hod) {
        console.log(`⏭️  ${symbol} - High ${bar.h.toFixed(2)} does not break HOD ${hod.toFixed(2)} (${((bar.h - hod) / hod * 100).toFixed(2)}% below) [STRICT MODE]`);
        return null;
      }
      console.log(`✅ ${symbol} - High proximity check passed: ${bar.h.toFixed(2)} breaks/touches HOD ${hod.toFixed(2)} [STRICT MODE]`);
    } else {
      // LOOSE: Candle HIGH can be within X% of HOD
      const highDistanceFromHOD = ((hod - bar.h) / hod) * 100; // Positive = below HOD, Negative = above HOD

      if (Math.abs(highDistanceFromHOD) > maxHighDistance) {
        console.log(`⏭️  ${symbol} - High ${bar.h.toFixed(2)} is ${Math.abs(highDistanceFromHOD).toFixed(2)}% from HOD ${hod.toFixed(2)} (max: ${maxHighDistance}%) [LOOSE MODE]`);
        return null;
      }
      console.log(`✅ ${symbol} - High proximity check passed: ${bar.h.toFixed(2)} is ${Math.abs(highDistanceFromHOD).toFixed(2)}% from HOD ${hod.toFixed(2)} (max: ${maxHighDistance}%) [LOOSE MODE]`);
    }

    // CHECK 2: Candle CLOSE must be within Y% below HOD (prevents low closes)
    // This catches cases where candle spikes to HOD but closes way below
    const closeDistanceFromHOD = ((hod - bar.c) / hod) * 100; // Positive = below HOD
    const maxCloseDistance = this.config.patterns.toppingTail5m.maxCloseDistanceFromHODPercent;

    // Only check if close is BELOW HOD (positive distance)
    if (closeDistanceFromHOD > maxCloseDistance) {
      console.log(`⏭️  ${symbol} - Close ${bar.c.toFixed(2)} is ${closeDistanceFromHOD.toFixed(2)}% below HOD ${hod.toFixed(2)} (max: ${maxCloseDistance}%) - closes too far below`);
      return null; // Close is too far below HOD
    }

    console.log(`✅ ${symbol} - Close proximity check passed: ${bar.c.toFixed(2)} is ${closeDistanceFromHOD.toFixed(2)}% below HOD ${hod.toFixed(2)}`);

    // Calculate candle metrics
    const totalRange = bar.h - bar.l;
    if (totalRange === 0) return null;

    // Determine candle color to calculate upper shadow correctly
    const isRed = bar.c < bar.o;
    const isGreen = bar.c > bar.o;
    const candleColor = isRed ? 'red' : isGreen ? 'green' : 'doji';

    // CHECK 3: Must close red if configured
    if (this.config.patterns.toppingTail5m.mustCloseRed && !isRed) {
      console.log(`⏭️  ${symbol} - Candle must close red but is ${candleColor} (O=${bar.o.toFixed(2)}, C=${bar.c.toFixed(2)})`);
      return null;
    }

    // Calculate upper shadow and body size
    // Upper shadow = distance from high to top of body
    // Body = distance between open and close
    const upperShadow = isRed ? (bar.h - bar.o) : (bar.h - bar.c);
    const body = Math.abs(bar.o - bar.c);

    // CRITICAL REQUIREMENT: Upper shadow must be at least minShadowToBodyRatio times the body size
    // This ensures we only catch true topping tails with significant rejection
    const shadowToBodyRatio = body > 0 ? upperShadow / body : Infinity;
    const minRatio = this.config.patterns.toppingTail5m.minShadowToBodyRatio;

    if (shadowToBodyRatio < minRatio) {
      console.log(`⏭️  ${symbol} - Rejecting topping tail: upper shadow ${upperShadow.toFixed(3)} / body ${body.toFixed(3)} = ${shadowToBodyRatio.toFixed(2)}x (need ${minRatio}x)`);
      return null;
    }

    console.log(`✅ ${symbol} - Upper shadow requirement met: shadow=${upperShadow.toFixed(3)}, body=${body.toFixed(3)}, ratio=${shadowToBodyRatio.toFixed(2)}x (min: ${minRatio}x)`);

    // CHECK 4: Calculate where the close is relative to the total range
    // closePercent = how far down from the high the close is (as a percentage)
    // If close is at low, closePercent = 100%
    // If close is at high, closePercent = 0%
    const closeDistanceFromHigh = bar.h - bar.c;
    const closePercent = (closeDistanceFromHigh / totalRange) * 100;

    const minClosePercent = this.config.patterns.toppingTail5m.minClosePercent;
    const meetsCloseRequirement = closePercent >= minClosePercent;

    if (!meetsCloseRequirement) {
      console.log(`⏭️  ${symbol} - Close requirement not met: ${closePercent.toFixed(1)}% down from high (need ${minClosePercent}%)`);
      return null;
    }

    console.log(`✅ ${symbol} - Close requirement met: ${closePercent.toFixed(1)}% down from high (need ${minClosePercent}%)`);

    // CHECK 5: Volume requirement
    const meetsVolumeRequirement = bar.v >= this.config.patterns.toppingTail5m.minBarVolume;

    if (!meetsVolumeRequirement) {
      console.log(`⏭️  ${symbol} - Volume requirement not met: ${bar.v.toLocaleString()} < ${this.config.patterns.toppingTail5m.minBarVolume.toLocaleString()}`);
      return null;
    }

    if (meetsCloseRequirement && meetsVolumeRequirement) {
      const alertVolume = cumulativeVolume || bar.v;

      // Validation for volume numbers using config
      const maxVolume = this.config.patterns.toppingTail5m.maxBarVolume;
      if (alertVolume > maxVolume) {
        console.error(`🚨 BLOCKING ALERT: ${symbol} volume ${(alertVolume/1000000).toFixed(1)}M exceeds max ${(maxVolume/1000000).toFixed(1)}M - likely data error`);
        return null;
      }

      // Calculate high distance from HOD for display
      const highDistanceFromHOD = ((hod - bar.h) / hod) * 100; // Positive = below HOD, Negative = above HOD
      const highDistanceDisplay = bar.h >= hod
        ? `+${Math.abs(highDistanceFromHOD).toFixed(2)}%`
        : `-${Math.abs(highDistanceFromHOD).toFixed(2)}%`;

      const hodDescription = requireStrictBreak ? 'broke HOD' : `near HOD (${((Math.abs(hod - bar.h) / hod) * 100).toFixed(1)}%)`;

      console.log(`✅ 5m TOPPING TAIL DETECTED: ${symbol} at ${this.formatETTime(timestamp)}`);
      console.log(`   📊 OHLC: O=${bar.o.toFixed(2)} H=${bar.h.toFixed(2)} L=${bar.l.toFixed(2)} C=${bar.c.toFixed(2)}`);
      console.log(`   ✓ HOD Break: ${hodDescription} (HOD=${hod.toFixed(2)})`);
      console.log(`   ✓ Close Distance from HOD: ${closeDistanceFromHOD.toFixed(1)}% (max ${maxCloseDistance}%)`);
      console.log(`   ✓ Close Position: ${closePercent.toFixed(1)}% down from high (min ${minClosePercent}%)`);
      console.log(`   ✓ Shadow/Body Ratio: ${shadowToBodyRatio.toFixed(2)}x (min ${minRatio}x)`);
      console.log(`   ✓ Candle Color: ${candleColor}`);
      console.log(`   ✓ Volume: ${bar.v.toLocaleString()}`);

      return {
        id: `${symbol}-${timestamp.getTime()}-${index}-ToppingTail5m`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'ToppingTail5m',
        detail: `5m TT @ HOD $${hod.toFixed(2)} | H:${highDistanceDisplay} C:${closeDistanceFromHOD.toFixed(1)}% below | ${closePercent.toFixed(0)}% down from high | ${shadowToBodyRatio.toFixed(1)}x shadow/body | ${candleColor} | Close $${bar.c.toFixed(2)}`,
        price: bar.c,
        volume: alertVolume,
        gapPercent: gapPercent,
        historical: true
      };
    }

    return null;
  }

  private detectGreenRunReject(symbol: string, bars5m: PolygonBar[], index: number, hod: number, timestamp: Date, cumulativeVolume?: number, gapPercent?: number): Alert | null {
    // bars5m are native 5-minute bars from Polygon - much simpler!

    console.log(`\n🔍 detectGreenRunReject called for ${symbol} at ${this.formatETTime(timestamp)}`);
    console.log(`   index=${index}, bars5m.length=${bars5m.length}, hod=${hod.toFixed(2)}, cumulativeVolume=${cumulativeVolume ? (cumulativeVolume/1000).toFixed(1) + 'K' : 'N/A'}`);

    // Need at least 4 green bars + 1 red bar
    if (index < 4) {
      console.log(`   ❌ INSUFFICIENT HISTORY: index=${index} < 4 - need at least 4 previous bars`);
      return null;
    }

    // Current bar should be red (the rejection bar)
    const currentBar = bars5m[index];

    // CRITICAL: Verify this is a completed 5-minute bar on a proper interval
    // 5-minute bars should end at minutes: 4, 9, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59
    const barTime = new Date(currentBar.t);
    const etBarTime = new Date(barTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const minutes = etBarTime.getMinutes();
    const seconds = etBarTime.getSeconds();

    // Polygon 5-minute bars start at 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55
    // So the bar timestamp should be aligned to these values
    const isProperlyAligned = minutes % 5 === 0 && seconds === 0;

    if (!isProperlyAligned) {
      console.log(`⚠️ ${symbol} - Bar at ${this.formatETTime(barTime)} is NOT properly aligned (${minutes}:${seconds}) - SKIPPING`);
      return null;
    }

    // Must be a red candle (close < open, and not a doji)
    // Use a small epsilon to avoid floating point comparison issues
    const epsilon = 0.001;
    const redDiff = currentBar.o - currentBar.c;
    const isRed = redDiff > epsilon;
    const percentDiff = ((currentBar.c - currentBar.o) / currentBar.o) * 100;

    console.log(`   Current bar: O=${currentBar.o.toFixed(3)}, C=${currentBar.c.toFixed(3)}, Diff=${redDiff.toFixed(3)} (${percentDiff.toFixed(3)}%)`);

    if (!isRed) {
      // Not red enough - could be doji or green
      console.log(`   ❌ NOT RED: Diff ${redDiff.toFixed(3)} <= epsilon ${epsilon} - candle is ${redDiff > 0 ? 'barely red/doji' : 'GREEN'}`);
      return null;
    }

    console.log(`   ✅ RED CANDLE CONFIRMED: ${this.formatETTime(timestamp)} - Diff=${redDiff.toFixed(3)} (${percentDiff.toFixed(3)}%)`);

    // Count consecutive green bars before the current red bar
    let consecutiveGreen = 0;
    let greenRunStartPrice: number | undefined;
    let greenRunHighPrice = currentBar.o; // Track the highest point during green run
    const greenCandles: Array<{ time: string; open: number; close: number; diff: number }> = [];

    // Look back to find consecutive green candles
    for (let lookback = 1; lookback <= 20; lookback++) { // Max 20 bars = 100 minutes lookback
      const lookbackIdx = index - lookback;
      if (lookbackIdx < 0) break;

      const bar = bars5m[lookbackIdx];

      // CRITICAL: Verify each lookback bar is also properly aligned
      const lookbackBarTime = new Date(bar.t);
      const etLookbackTime = new Date(lookbackBarTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
      const lookbackMinutes = etLookbackTime.getMinutes();
      const lookbackSeconds = etLookbackTime.getSeconds();
      const isLookbackAligned = lookbackMinutes % 5 === 0 && lookbackSeconds === 0;

      if (!isLookbackAligned) {
        console.log(`   ⚠️ Lookback ${lookback}: Bar at ${this.formatETTime(lookbackBarTime)} NOT aligned (${lookbackMinutes}:${lookbackSeconds}) - STOPPING`);
        break;
      }

      // Must be a GREEN candle (close > open, and not a doji)
      // Use epsilon to avoid floating point comparison issues
      const epsilon = 0.001;
      const isGreen = (bar.c - bar.o) > epsilon;
      const priceDiff = bar.c - bar.o;
      const percentDiff = ((bar.c - bar.o) / bar.o) * 100;

      console.log(`   Lookback ${lookback}: 5m candle at ${this.formatETTime(lookbackBarTime)}: O=${bar.o.toFixed(3)}, C=${bar.c.toFixed(3)}, Diff=${priceDiff.toFixed(3)} (${percentDiff.toFixed(3)}%) ${isGreen ? 'GREEN ✓' : 'RED/DOJI ✗'}`);

      if (isGreen) {
        if (consecutiveGreen === 0) {
          greenRunStartPrice = bar.o;
        }
        consecutiveGreen++;

        // Track details for logging
        greenCandles.unshift({
          time: this.formatETTime(lookbackBarTime),
          open: bar.o,
          close: bar.c,
          diff: priceDiff
        });

        // Track the highest point during the green run
        greenRunHighPrice = Math.max(greenRunHighPrice, bar.h);
      } else {
        // Hit a non-green bar, stop counting (must be consecutive)
        console.log(`   ⛔ Found non-green candle, stopping count. Total consecutive green: ${consecutiveGreen}`);
        break;
      }
    }

    console.log(`📈 ${symbol} - Found ${consecutiveGreen} consecutive green 5m candles before red candle`);
    if (greenCandles.length > 0) {
      console.log(`   Green candles: ${greenCandles.map(c => `${c.time} (${c.open.toFixed(3)}→${c.close.toFixed(3)} Δ${c.diff.toFixed(3)})`).join(', ')}`);
    }

    // Check if we meet the minimum consecutive green requirement
    if (consecutiveGreen < this.config.patterns.greenRun.minConsecutiveGreen) {
      console.log(`   ❌ MIN GREEN FILTER: Found ${consecutiveGreen} green candles < minimum ${this.config.patterns.greenRun.minConsecutiveGreen} required`);
      return null;
    }

    // Check if we're within the max consecutive green limit
    if (consecutiveGreen > this.config.patterns.greenRun.maxConsecutiveGreen) {
      return null;
    }

    // Calculate total gain during green run
    if (!greenRunStartPrice) return null;

    const totalGainPercent = ((greenRunHighPrice - greenRunStartPrice) / greenRunStartPrice) * 100;

    console.log(`   📊 Green run gain: ${totalGainPercent.toFixed(2)}% (${greenRunStartPrice.toFixed(3)} → ${greenRunHighPrice.toFixed(3)})`);

    // Check if gain meets minimum requirement
    if (totalGainPercent < this.config.patterns.greenRun.minRunGainPercent) {
      console.log(`   ❌ MIN GAIN FILTER: Gain ${totalGainPercent.toFixed(2)}% < minimum ${this.config.patterns.greenRun.minRunGainPercent}% required`);
      return null;
    }

    // CRITICAL: Check if green run is near HOD (including pre-market and previous day post-market)
    // This filters out green runs that occur in the middle or lower part of the range
    const distanceFromHOD = ((hod - greenRunHighPrice) / hod) * 100;
    const maxAllowedDistance = this.config.patterns.greenRun.maxDistanceFromHODPercent;

    if (distanceFromHOD > maxAllowedDistance) {
      console.log(`⏭️  Skipping green run for ${symbol}: ${distanceFromHOD.toFixed(2)}% from HOD (max allowed: ${maxAllowedDistance}%) - not near HOD`);
      return null;
    }

    console.log(`✅ Green run near HOD for ${symbol}: ${distanceFromHOD.toFixed(2)}% from HOD (high: ${greenRunHighPrice.toFixed(2)}, HOD: ${hod.toFixed(2)})`);


    const alertVolume = cumulativeVolume || currentBar.v;

    // Validation for volume numbers
    if (alertVolume > 50000000) {
      console.error(`🚨 BLOCKING ALERT: ${symbol} volume ${(alertVolume/1000000).toFixed(1)}M is unrealistically high - likely data error`);
      return null;
    }

    // Final comprehensive log before generating alert
    console.log(`\n🎯 GENERATING GREEN RUN REJECT ALERT for ${symbol}:`);
    console.log(`   Pattern: ${consecutiveGreen} consecutive GREEN candles followed by 1 RED candle`);
    console.log(`   Green candles (${greenCandles.length}):`);
    greenCandles.forEach((c, i) => {
      console.log(`      ${i + 1}. ${c.time}: Open=${c.open.toFixed(3)}, Close=${c.close.toFixed(3)}, Gain=${c.diff.toFixed(3)} ✓`);
    });
    console.log(`   Red rejection candle:`);
    console.log(`      ${this.formatETTime(timestamp)}: Open=${currentBar.o.toFixed(3)}, Close=${currentBar.c.toFixed(3)}, Loss=${(currentBar.o - currentBar.c).toFixed(3)} ✓`);
    console.log(`   Total run gain: ${totalGainPercent.toFixed(2)}% (${greenRunStartPrice?.toFixed(3)} → ${greenRunHighPrice.toFixed(3)})`);
    console.log(`   HOD: ${hod.toFixed(3)}, Distance: ${distanceFromHOD.toFixed(2)}%`);
    console.log(`   Volume: ${(alertVolume/1000).toFixed(1)}K\n`);

    return {
      id: `${symbol}-${timestamp.getTime()}-${index}-GreenRunReject`,
      timestamp: timestamp.getTime(),
      symbol,
      type: 'GreenRunReject',
      detail: `${consecutiveGreen} green 5m candles (+${totalGainPercent.toFixed(1)}%) near HOD (${distanceFromHOD.toFixed(1)}% from HOD), red rejection at ${currentBar.c.toFixed(2)}`,
      price: currentBar.c,
      volume: alertVolume,
      gapPercent: gapPercent,
      historical: true
    };
  }

  // Helper method to get EMA200 daily for a symbol
  private async getEMA200Daily(symbol: string): Promise<number | null> {
    try {
      // Use Polygon EMA indicator endpoint
      const today = new Date();
      const thirtyDaysAgo = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));
      const startDate = thirtyDaysAgo.toISOString().split('T')[0];
      const endDate = today.toISOString().split('T')[0];

      const url = `https://api.polygon.io/v1/indicators/ema/${symbol}?timestamp.gte=${startDate}&timestamp.lte=${endDate}&timespan=day&adjusted=true&window=200&series_type=close&order=desc&limit=1&apikey=${this.polygonApiKey}`;

      const response = await this.cachedFetch(url);

      if (response.results && response.results.values && response.results.values.length > 0) {
        return response.results.values[0].value;
      }

      return null;
    } catch (error) {
      console.warn(`Failed to fetch EMA200 for ${symbol}:`, error);
      return null;
    }
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

      // Get 15-minute bars for today's configured market hours
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
      const configStart = this.getConfigStartHour();
      const configEnd = this.getConfigEndHour();

      const marketHoursBars = barsData.results.filter(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= configStart && etHour < configEnd;
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