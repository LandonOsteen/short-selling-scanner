// Gap Scanner Service - Real gap stock detection with volume criteria
import { Alert, PatternType, SymbolData } from '../types';

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

  // Performance optimizations
  private requestCache: Map<string, { data: any; timestamp: number }> = new Map();
  private requestQueue: Map<string, Promise<any>> = new Map();
  private maxRetries: number = 3;
  private cacheTimeout: number = 30000; // 30 seconds

  constructor(apiKey?: string) {
    this.polygonApiKey = apiKey || process.env.REACT_APP_POLYGON_API_KEY || '';
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
          timeout: 10000, // 10 second timeout
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

  // Scan for gap stocks with criteria: ≥20% gap, ≥500k volume between 4:00-9:30 AM ET
  async scanForGappers(): Promise<GapStock[]> {
    try {
      const now = new Date();
      const etHour = this.getETHour(now);

      console.log(`Scanning for gappers at ET time: ${this.formatETTime(now)} (${etHour.toFixed(2)})`);

      // Always fetch real gap stocks from API when available
      // This ensures consistent data regardless of login time
      const gappers = await this.fetchGappersFromAPI();

      // Filter based on our criteria: >=20% gap, >=500k volume, $1-$10 price range
      const filteredGappers = gappers.filter(stock =>
        stock.gapPercent >= 20 &&
        stock.cumulativeVolume >= 500000 &&
        stock.currentPrice >= 1 &&
        stock.currentPrice <= 10
      );

      // Update our gap stocks map
      filteredGappers.forEach(stock => {
        this.gapStocks.set(stock.symbol, stock);
      });

      console.log(`Found ${filteredGappers.length} qualified gap stocks`);
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
      console.log(`Fetching gappers from Polygon API at ET ${this.formatETTime(now)}`);

      // Use different strategies based on market session
      let qualifyingStocks: GapStock[] = [];

      if (etHour >= 4 && etHour < 9.5) {
        // Pre-market hours: Use real-time gainers data
        qualifyingStocks = await this.fetchPreMarketGappers(today);
      } else {
        // Outside pre-market: Use historical analysis for consistent results
        qualifyingStocks = await this.fetchHistoricalGappers(today);
      }

      console.log(`Found ${qualifyingStocks.length} qualifying gap stocks:`, qualifyingStocks.map(s => s.symbol));

      // Return only real data - no fallback to mock data
      return qualifyingStocks;

    } catch (error) {
      console.error('Error fetching gainers:', error);
      throw error; // Propagate error instead of falling back to mock data
    }
  }

  // Fetch pre-market gappers using real-time data
  private async fetchPreMarketGappers(today: string): Promise<GapStock[]> {
    const gainersUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apikey=${this.polygonApiKey}`;

    const gainersData: PolygonGainersResponse = await this.cachedFetch(gainersUrl);

    if (gainersData.status !== 'OK' || !gainersData.results) {
      console.warn('No real-time gainers data available');
      return [];
    }

    console.log(`Processing ${gainersData.results.length} real-time gainers`);

    const qualifyingStocks: GapStock[] = [];

    for (const gainer of gainersData.results.slice(0, 20)) {
      try {
        if (gainer.change_percentage < 20) continue;

        const gapStock = await this.analyzeStockForGap(gainer.ticker, today);
        if (gapStock) {
          qualifyingStocks.push(gapStock);
        }
      } catch (error) {
        console.warn(`Error analyzing ${gainer.ticker}:`, error);
      }
    }

    return qualifyingStocks;
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


  // Backfill data using Polygon REST API for historical 1-minute bars
  async backfillMissedData(): Promise<Alert[]> {
    const now = new Date();
    const startTime = this.getTodayAt4AM();
    const marketEnd = this.getTodayAt930AM();

    console.log('=== BACKFILL DEBUG ===');
    console.log('Current time:', this.formatETTime(now));
    console.log('4:00 AM ET:', this.formatETTime(startTime));
    console.log('9:30 AM ET:', this.formatETTime(marketEnd));
    console.log('API Key available:', !!this.polygonApiKey);

    // Determine current ET time for consistent time window logic
    const etHour = this.getETHour(now);

    // Backfill logic: always provide historical data from 4:00 AM to 9:30 AM ET for the current trading day
    let endTime: number;

    if (etHour < 4) {
      console.log('Accessing before market pre-market hours - no backfill needed');
      return [];
    } else if (etHour >= 4 && etHour < 9.5) {
      // During pre-market: backfill from 4:00 AM to current time
      endTime = now.getTime();
      console.log(`Pre-market session active - backfilling from 4:00 AM to current time`);
    } else {
      // After 9:30 AM: backfill the complete pre-market session (4:00 AM - 9:30 AM)
      endTime = marketEnd.getTime();
      console.log(`Market open - backfilling complete pre-market session (4:00 AM - 9:30 AM)`);
    }

    console.log(`Backfilling data from ${this.formatETTime(startTime)} to ${this.formatETTime(new Date(endTime))}`);

    // Use today's date in ET timezone for historical scan
    const etNowForDate = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const todayDateString = `${etNowForDate.getFullYear()}-${String(etNowForDate.getMonth() + 1).padStart(2, '0')}-${String(etNowForDate.getDate()).padStart(2, '0')}`;
    console.log(`Using today's date (ET timezone) for backfill: ${todayDateString}`);

    try {
      // Get today's historical alerts (this will use proper filtering)
      const backfilledAlerts = await this.getHistoricalAlertsForDate(todayDateString);

      // Filter alerts to only include those in our backfill time window
      const filteredAlerts = backfilledAlerts.filter(alert =>
        alert.timestamp >= startTime.getTime() && alert.timestamp <= endTime
      );

      console.log(`Backfilled ${filteredAlerts.length} alerts from ${this.formatETTime(startTime)} to ${this.formatETTime(new Date(endTime))}`);

      return filteredAlerts.sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      console.error('Backfill failed, using fallback method:', error);

      // If no API key, throw error instead of using mock data
      if (!this.polygonApiKey) {
        console.error('No Polygon API key provided - cannot generate historical alerts');
        throw new Error('Polygon API key required for historical backfill');
      }

      return [];
    }
  }

  // Start continuous scanning
  startScanning(): void {
    if (this.isScanning) return;

    this.isScanning = true;
    console.log('Starting gap stock scanner...');

    // Initial scan
    this.scanForGappers();

    // Scan every 30 seconds - always scan during pre-market hours (4:00 AM - 9:30 AM ET)
    this.scanInterval = window.setInterval(async () => {
      try {
        await this.scanForGappers();

        // Scan for live patterns during pre-market hours (4:00 AM - 9:30 AM ET)
        const now = new Date();
        const etHour = this.getETHour(now);

        if (etHour >= 4 && etHour < 9.5) {
          console.log(`Scanning for live patterns at ${this.formatETTime(now)} (ET hour: ${etHour.toFixed(2)})`);
          await this.scanForLivePatterns();
        } else {
          console.log(`Outside pre-market hours at ${this.formatETTime(now)} (ET hour: ${etHour.toFixed(2)}) - skipping live pattern scan`);
        }
      } catch (error) {
        console.error('Error in scanning interval:', error);
      }
    }, 30000);
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
      bid: stock.currentPrice - 0.01,
      ask: stock.currentPrice + 0.01
    }));
  }

  // Register alert callback
  onAlert(callback: (alert: Alert) => void): void {
    this.alertCallbacks.push(callback);
  }

  // Fire alert to all callbacks
  private fireAlert(alert: Alert): void {
    this.alertCallbacks.forEach(callback => {
      try {
        callback(alert);
      } catch (error) {
        console.error('Error in alert callback:', error);
      }
    });
  }

  // Scan for live patterns during premarket hours
  private async scanForLivePatterns(): Promise<void> {
    try {
      console.log('Scanning for live patterns...');

      // Get current gap stocks being tracked
      const currentGapStocks = Array.from(this.gapStocks.values());

      if (currentGapStocks.length === 0) {
        console.log('No gap stocks to scan for patterns');
        return;
      }

      // Scan each gap stock for patterns
      for (const gapStock of currentGapStocks) {
        try {
          const alerts = await this.scanStockForLivePatterns(gapStock);
          alerts.forEach(alert => this.fireAlert(alert));
        } catch (error) {
          console.warn(`Failed to scan ${gapStock.symbol} for live patterns:`, error);
        }
      }

    } catch (error) {
      console.error('Error scanning for live patterns:', error);
    }
  }

  // Scan a specific stock for live patterns
  private async scanStockForLivePatterns(gapStock: GapStock): Promise<Alert[]> {
    const now = Date.now();
    const alerts: Alert[] = [];

    try {
      // Get recent 1-minute bars for the last 10 minutes
      const endTime = new Date(now);
      const startTime = new Date(now - 10 * 60 * 1000); // 10 minutes ago

      const bars = await this.getHistoricalBars(gapStock.symbol, startTime, endTime);

      if (bars.length > 0) {
        // Detect patterns in recent bars
        const detectedAlerts = await this.detectPatternsInBars(gapStock.symbol, bars, gapStock.ema200);

        // Filter to only new alerts (within last minute to avoid duplicates)
        const recentAlerts = detectedAlerts.filter(alert =>
          now - alert.timestamp < 60000 // Last minute
        );

        alerts.push(...recentAlerts);

        if (recentAlerts.length > 0) {
          console.log(`Found ${recentAlerts.length} new patterns for ${gapStock.symbol}`);
        }
      }

    } catch (error) {
      console.warn(`Error scanning ${gapStock.symbol} for patterns:`, error);
    }

    return alerts;
  }

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
      if (daysAgo > 730) { // ~2 years
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
          console.log(`Step 3: Scanning ${gapStock.symbol} for patterns...`);
          const stockAlerts = await this.scanHistoricalStock(gapStock.symbol, dateString);
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

        // Filter for our criteria: ≥20% gap up, ≥500k volume, price between $1-$10
        if (gapPercent >= 20 && bar.v >= 500000 && bar.o >= 1 && bar.o <= 10) {
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
      return qualifyingStocks.slice(0, 20); // Limit to top 20 for performance

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
  private async scanHistoricalStock(symbol: string, dateString: string): Promise<Alert[]> {
    try {
      // Get 1-minute bars for pre-market hours (4:00 AM - 9:30 AM ET)
      const bars = await this.getHistoricalMinuteBars(symbol, dateString);

      if (bars.length === 0) {
        return [];
      }

      // Calculate HOD from the bars
      const hod = Math.max(...bars.map(bar => bar.h));

      const alerts: Alert[] = [];

      // Scan each bar for patterns
      bars.forEach((bar, index) => {
        const timestamp = new Date(bar.t);

        // Skip if outside pre-market hours (4:00 AM - 9:30 AM ET)
        const etHour = this.getETHour(timestamp);
        if (etHour < 4 || etHour >= 9.5) {
          return;
        }

        // Check all pattern types
        const patterns = [
          this.detectToppingTail(symbol, bar, timestamp, hod),
          this.detectHODBreakCloseUnder(symbol, bars, index, hod, timestamp),
          this.detectNewLowNearHOD(symbol, bars, index, hod, timestamp),
          this.detectGreenThenRed(symbol, bars, index, timestamp, hod),
          // Note: EMA200 and DoubleTop/TripleTop patterns would need additional data
        ];

        patterns.forEach(alert => {
          if (alert) {
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
      const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${dateString}/${dateString}?adjusted=true&sort=asc&limit=50000&apikey=${this.polygonApiKey}`;

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

  private getTodayAt4AM(): Date {
    const now = new Date();
    // Get current ET time
    const etTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    // Create 4:00 AM ET today in local timezone
    const fourAMET = new Date(etTime.getFullYear(), etTime.getMonth(), etTime.getDate(), 4, 0, 0);
    // Convert from ET back to UTC/local
    const utcOffset = now.getTimezoneOffset() * 60000;
    const etOffset = fourAMET.getTimezoneOffset() * 60000;
    return new Date(fourAMET.getTime() + etOffset - utcOffset);
  }

  private getTodayAt930AM(): Date {
    const now = new Date();
    // Get current ET time
    const etTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    // Create 9:30 AM ET today in local timezone
    const nineThirtyAMET = new Date(etTime.getFullYear(), etTime.getMonth(), etTime.getDate(), 9, 30, 0);
    // Convert from ET back to UTC/local
    const utcOffset = now.getTimezoneOffset() * 60000;
    const etOffset = nineThirtyAMET.getTimezoneOffset() * 60000;
    return new Date(nineThirtyAMET.getTime() + etOffset - utcOffset);
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
    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&apikey=${this.polygonApiKey}`;

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
      'ToppingTail1m', 'HODBreakCloseUnder', 'New1mLowNearHOD',
      'EMA200Reject', 'DoubleTop', 'Run4PlusGreenThenRed'
    ];

    const fiveMinutePatterns: PatternType[] = [
      'ToppingTail5m', 'HODBreakCloseUnder', 'New1mLowNearHOD',
      'EMA200Reject', 'DoubleTop'
    ];

    // Use 5-minute patterns on 5-minute intervals, otherwise use 1-minute patterns
    const availablePatterns = is5MinuteInterval && Math.random() > 0.5
      ? fiveMinutePatterns
      : oneMinutePatterns;

    return availablePatterns[Math.floor(Math.random() * availablePatterns.length)];
  }

  private getRandomPatternType(): PatternType {
    const patterns: PatternType[] = [
      'ToppingTail1m', 'HODBreakCloseUnder', 'New1mLowNearHOD',
      'EMA200Reject', 'DoubleTop', 'Run4PlusGreenThenRed'
    ];
    return patterns[Math.floor(Math.random() * patterns.length)];
  }

  // Get historical 1-minute bars from Polygon API
  private async getHistoricalBars(symbol: string, startTime: Date, endTime: Date): Promise<PolygonBar[]> {
    const startDate = startTime.toISOString().split('T')[0]; // YYYY-MM-DD
    const endDate = endTime.toISOString().split('T')[0];

    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${startDate}/${endDate}?adjusted=true&sort=asc&limit=50000&apikey=${this.polygonApiKey}`;

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

      // Filter bars to only include pre-market hours (4:00 AM - 9:30 AM ET)
      const filteredBars = data.results.filter(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= 4 && etHour < 9.5;
      });

      console.log(`Retrieved ${filteredBars.length} 1-minute bars for ${symbol}`);
      return filteredBars;

    } catch (error) {
      console.error(`Error fetching data for ${symbol}:`, error);
      return [];
    }
  }

  // Detect patterns in historical bars
  private async detectPatternsInBars(symbol: string, bars: PolygonBar[], ema200?: number): Promise<Alert[]> {
    const alerts: Alert[] = [];

    if (bars.length < 5) {
      return alerts; // Need at least 5 bars for pattern detection
    }

    // Calculate extended HOD including previous day after-hours + current pre-market
    const hod = await this.getExtendedHOD(symbol, bars);

    for (let i = 4; i < bars.length; i++) {
      const currentBar = bars[i];
      const barTime = new Date(currentBar.t);

      // 1. Topping Tail 1m - ≥50% upper wick and red close
      const toppingTailAlert = this.detectToppingTail(symbol, currentBar, barTime, hod);
      if (toppingTailAlert) alerts.push(toppingTailAlert);

      // 2. HOD Break Close Under
      const hodBreakAlert = this.detectHODBreakCloseUnder(symbol, bars, i, hod, barTime);
      if (hodBreakAlert) alerts.push(hodBreakAlert);

      // 3. New 1m Low Near HOD
      const newLowAlert = this.detectNewLowNearHOD(symbol, bars, i, hod, barTime);
      if (newLowAlert) alerts.push(newLowAlert);

      // 4. 4+ Green Then Red - only near HOD
      const greenThenRedAlert = this.detectGreenThenRed(symbol, bars, i, barTime, hod);
      if (greenThenRedAlert) alerts.push(greenThenRedAlert);

      // 5. Double Top - only near HOD
      const doubleTopAlert = this.detectDoubleTop(symbol, bars, i, barTime, hod);
      if (doubleTopAlert) alerts.push(doubleTopAlert);

      // 7. Triple Top - only near HOD
      const tripleTopAlert = this.detectTripleTop(symbol, bars, i, barTime, hod);
      if (tripleTopAlert) alerts.push(tripleTopAlert);

      // 6. EMA200 Reject - broke above then closed below 200 EMA (only if EMA200 available)
      if (ema200) {
        const ema200Alert = this.detectEMA200Reject(symbol, bars, i, barTime, ema200, hod);
        if (ema200Alert) alerts.push(ema200Alert);
      }

      // Only process 5-minute patterns on 5-minute intervals
      const minute = barTime.getMinutes();
      if (minute % 5 === 0 && i >= 9) { // Need more bars for 5-minute patterns
        const toppingTail5mAlert = this.detectToppingTail5m(symbol, bars, i, barTime, hod);
        if (toppingTail5mAlert) alerts.push(toppingTail5mAlert);
      }
    }

    return alerts;
  }

  // Pattern detection methods
  private detectToppingTail(symbol: string, bar: PolygonBar, timestamp: Date, hod: number): Alert | null {
    const fullSize = bar.h - bar.l;
    const upperWick = bar.h - Math.max(bar.o, bar.c);

    if (fullSize === 0) return null;

    const wickPercent = upperWick / fullSize;
    const isRed = bar.c < bar.o;

    // More lenient HOD check - within 5% of HOD or if it's a strong wick pattern
    const nearHOD = bar.h >= hod * 0.95 || wickPercent >= 0.65;

    if (wickPercent >= 0.5 && isRed && bar.v > 5000 && nearHOD) {
      return {
        id: `${symbol}-${timestamp.getTime()}-ToppingTail1m`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'ToppingTail1m',
        detail: `${(wickPercent * 100).toFixed(0)}% upper wick near HOD ${hod.toFixed(2)}`,
        price: bar.c,
        volume: bar.v,
        historical: true
      };
    }

    return null;
  }

  private detectHODBreakCloseUnder(symbol: string, bars: PolygonBar[], index: number, hod: number, timestamp: Date): Alert | null {
    if (index < 1) return null; // Need previous bar

    const currentBar = bars[index];
    const prevBar = bars[index - 1];

    // Check if previous bar broke HOD and current bar closed under (more lenient thresholds)
    if (prevBar.h >= hod * 0.995 && currentBar.c < hod * 0.99) {
      return {
        id: `${symbol}-${timestamp.getTime()}-HODBreakCloseUnder`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'HODBreakCloseUnder',
        detail: `Broke HOD ${hod.toFixed(2)}, closed under at ${currentBar.c.toFixed(2)}`,
        price: currentBar.c,
        volume: currentBar.v,
        historical: true
      };
    }

    return null;
  }

  private detectNewLowNearHOD(symbol: string, bars: PolygonBar[], index: number, hod: number, timestamp: Date): Alert | null {
    if (index < 1) return null; // Need previous bar to compare

    const currentBar = bars[index];
    const previousBar = bars[index - 1];

    // Check if current bar low breaks the previous 1-minute candle low
    // AND we're still near HOD (within 5% of HOD)
    const breaksPreviousLow = currentBar.l < previousBar.l;
    const nearHOD = currentBar.h >= hod * 0.95; // Still within 5% of HOD
    const hasVolume = currentBar.v > 5000;

    if (breaksPreviousLow && nearHOD && hasVolume) {
      return {
        id: `${symbol}-${timestamp.getTime()}-New1mLowNearHOD`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'New1mLowNearHOD',
        detail: `Live break of prev 1m low ${previousBar.l.toFixed(2)} near HOD ${hod.toFixed(2)}`,
        price: currentBar.l, // Use the low that broke, not the close
        volume: currentBar.v,
        historical: true
      };
    }

    return null;
  }

  private detectGreenThenRed(symbol: string, bars: PolygonBar[], index: number, timestamp: Date, hod: number): Alert | null {
    if (index < 4) return null;

    const currentBar = bars[index];
    const prevBars = bars.slice(index - 4, index);

    // Check if last 4 bars were green and current is red
    const allGreen = prevBars.every(bar => bar.c > bar.o);
    const currentRed = currentBar.c < currentBar.o;

    // Only trigger near HOD (within 5% of HOD)
    const nearHOD = currentBar.h >= hod * 0.95;

    if (allGreen && currentRed && nearHOD) {
      return {
        id: `${symbol}-${timestamp.getTime()}-Run4PlusGreenThenRed`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'Run4PlusGreenThenRed',
        detail: `4 green candles then red near HOD ${hod.toFixed(2)}`,
        price: currentBar.c,
        volume: currentBar.v,
        historical: true
      };
    }

    return null;
  }

  private detectDoubleTop(symbol: string, bars: PolygonBar[], index: number, timestamp: Date, hod: number): Alert | null {
    if (index < 10) return null;

    const currentBar = bars[index];
    const recentBars = bars.slice(index - 10, index + 1);

    // Look for two peaks near HOD level within recent bars
    const peaks = recentBars
      .map((bar, i) => ({ bar, index: i }))
      .filter(({ bar }) => bar.h >= hod * 0.98); // Within 2% of HOD

    if (peaks.length >= 2) {
      // Check if we're at or near a peak and showing rejection
      if (currentBar.c < currentBar.h * 0.95 && currentBar.h >= hod * 0.98) {
        return {
          id: `${symbol}-${timestamp.getTime()}-DoubleTop`,
          timestamp: timestamp.getTime(),
          symbol,
          type: 'DoubleTop',
          detail: `Double top near HOD ${hod.toFixed(2)}, rejection at ${currentBar.h.toFixed(2)}`,
          price: currentBar.c,
          volume: currentBar.v,
          historical: true
        };
      }
    }

    return null;
  }

  private detectTripleTop(symbol: string, bars: PolygonBar[], index: number, timestamp: Date, hod: number): Alert | null {
    if (index < 15) return null;

    const currentBar = bars[index];
    const recentBars = bars.slice(index - 15, index + 1);

    // Look for three peaks near HOD level within recent bars
    const peaks = recentBars
      .map((bar, i) => ({ bar, index: i, high: bar.h }))
      .filter(({ high }) => high >= hod * 0.98) // Within 2% of HOD
      .sort((a, b) => b.high - a.high);

    if (peaks.length >= 3) {
      // Check that the three highest peaks are reasonably close in price (within 1% of each other)
      const topThreePeaks = peaks.slice(0, 3);
      const highestPeak = topThreePeaks[0].high;
      const lowestOfTopThree = topThreePeaks[2].high;
      const priceRange = (highestPeak - lowestOfTopThree) / highestPeak;

      // Check if we're showing rejection at current bar
      const showingRejection = currentBar.c < currentBar.h * 0.95 && currentBar.h >= hod * 0.98;

      if (priceRange <= 0.01 && showingRejection) { // Within 1% range for triple top
        return {
          id: `${symbol}-${timestamp.getTime()}-TripleTop`,
          timestamp: timestamp.getTime(),
          symbol,
          type: 'TripleTop',
          detail: `Triple top near HOD ${hod.toFixed(2)}, rejection at ${currentBar.h.toFixed(2)}`,
          price: currentBar.c,
          volume: currentBar.v,
          historical: true
        };
      }
    }

    return null;
  }

  private detectEMA200Reject(symbol: string, bars: PolygonBar[], index: number, timestamp: Date, ema200: number, hod: number): Alert | null {
    if (index < 2) return null; // Need previous bars to detect the pattern

    const currentBar = bars[index];
    const prevBar = bars[index - 1];

    // Pattern: Previous bar broke above EMA200, current bar closed below EMA200
    const brokeAbove = prevBar.h > ema200;
    const closedBelow = currentBar.c < ema200;

    // Only trigger if we also have some volume, stock was strong (near EMA200), and near HOD
    const hasVolume = currentBar.v > 5000;
    const nearEMA = Math.abs(currentBar.c - ema200) / ema200 < 0.05; // Within 5% of EMA200
    const nearHOD = currentBar.h >= hod * 0.95; // Within 5% of HOD

    if (brokeAbove && closedBelow && hasVolume && nearEMA && nearHOD) {
      return {
        id: `${symbol}-${timestamp.getTime()}-EMA200Reject`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'EMA200Reject',
        detail: `Broke above 200 EMA $${ema200.toFixed(2)} near HOD ${hod.toFixed(2)}, rejected and closed below at $${currentBar.c.toFixed(2)}`,
        price: currentBar.c,
        volume: currentBar.v,
        historical: true
      };
    }

    return null;
  }

  private detectToppingTail5m(symbol: string, bars: PolygonBar[], index: number, timestamp: Date, hod: number): Alert | null {
    // Aggregate last 5 bars into a 5-minute bar
    const fiveMinBars = bars.slice(index - 4, index + 1);
    const fiveMinBar = {
      o: fiveMinBars[0].o,
      h: Math.max(...fiveMinBars.map(b => b.h)),
      l: Math.min(...fiveMinBars.map(b => b.l)),
      c: fiveMinBars[fiveMinBars.length - 1].c,
      v: fiveMinBars.reduce((sum, b) => sum + b.v, 0)
    };

    const fullSize = fiveMinBar.h - fiveMinBar.l;
    const upperWick = fiveMinBar.h - Math.max(fiveMinBar.o, fiveMinBar.c);

    if (fullSize === 0) return null;

    const wickPercent = upperWick / fullSize;
    const isRed = fiveMinBar.c < fiveMinBar.o;

    // Only trigger 5m topping tails near HOD (within 3% of HOD)
    const nearHOD = fiveMinBar.h >= hod * 0.97;

    if (wickPercent >= 0.5 && isRed && fiveMinBar.v > 50000 && nearHOD) {
      return {
        id: `${symbol}-${timestamp.getTime()}-ToppingTail5m`,
        timestamp: timestamp.getTime(),
        symbol,
        type: 'ToppingTail5m',
        detail: `5m: ${(wickPercent * 100).toFixed(0)}% upper wick near HOD ${hod.toFixed(2)}`,
        price: fiveMinBar.c,
        volume: fiveMinBar.v,
        historical: true
      };
    }

    return null;
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
        .filter(bar => bar.v >= 50000) // Reduced from 100k to 50k to be less restrictive
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
          ticker.day?.v >= 50000 // Some volume
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

      // Filter to pre-market hours (4:00 AM - 9:30 AM ET)
      const preMarketBars = barsData.results.filter(bar => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= 4 && etHour < 9.5;
      });

      if (preMarketBars.length === 0) {
        return null;
      }

      // Calculate metrics
      const currentPrice = preMarketBars[preMarketBars.length - 1].c;
      const hod = await this.getExtendedHOD(symbol, preMarketBars);
      const totalVolume = preMarketBars.reduce((sum, bar) => sum + bar.v, 0);
      const gapPercent = ((currentPrice - previousClose) / previousClose) * 100;

      // Calculate daily 200 EMA (only once per symbol per day)
      const ema200 = await this.getDailyEMA200(symbol, date);

      // Debug logging for all symbols being analyzed
      console.log(`📊 ${symbol}: ${gapPercent.toFixed(1)}% gap, ${(totalVolume / 1000).toFixed(0)}k volume, $${currentPrice.toFixed(2)}, ${preMarketBars.length} bars`);

      // Criteria: ≥20% gap, ≥500k volume, $1-$10 price range
      if (gapPercent >= 20 && totalVolume >= 500000 && currentPrice >= 1.00 && currentPrice <= 10.00) {
        console.log(`✅ ${symbol}: QUALIFIED - ${gapPercent.toFixed(1)}% gap, ${(totalVolume / 1000).toFixed(0)}k volume, $${currentPrice.toFixed(2)}`);

        return {
          symbol,
          gapPercent,
          currentPrice,
          previousClose,
          volume: preMarketBars[preMarketBars.length - 1].v,
          cumulativeVolume: totalVolume,
          hod,
          lastUpdated: Date.now(),
          ema200
        };
      } else {
        const gapReason = gapPercent < 20 ? 'gap<20%' : '';
        const volumeReason = totalVolume < 500000 ? 'vol<500k' : '';
        const priceLowReason = currentPrice < 1.00 ? 'price<$1' : '';
        const priceHighReason = currentPrice > 10.00 ? 'price>$10' : '';
        const reasons = [gapReason, volumeReason, priceLowReason, priceHighReason].filter(r => r).join(', ');
        console.log(`❌ ${symbol}: REJECTED - ${gapPercent.toFixed(1)}% gap, ${(totalVolume / 1000).toFixed(0)}k volume (${reasons})`);
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