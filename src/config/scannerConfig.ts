/**
 * Scanner Configuration
 *
 * This file contains all configurable parameters for the premarket scanner.
 * Adjust these values to fine-tune the scanning behavior and signal detection.
 */

export interface ScannerConfig {
  // Market Hours Configuration
  // IMPORTANT: Signal detection is CONSISTENT throughout this window
  // The system maintains the same HOD calculation, volume metrics, and pattern
  // detection logic when transitioning from pre-market to regular hours (9:30 AM).
  // This ensures signals generated at 6:00 AM work the same way as signals at 9:45 AM.
  marketHours: {
    // Scanning timeframe (24-hour format)
    // Only signals that occur within this window will be detected
    startTime: string; // "06:00" for 6:00 AM
    endTime: string; // "10:00" for 10:00 AM
    timezone: string; // "America/New_York"
  };

  // Gap Stock Filtering Criteria
  gapCriteria: {
    // Minimum gap percentage from previous day's close
    minGapPercentage: number; // 5.0 = 5%

    // Maximum gap percentage (to filter out extreme gaps)
    maxGapPercentage: number; // 50.0 = 50%

    // Price range filtering
    minPrice: number; // $1.00
    maxPrice: number; // $10.00

    // Volume requirements (cumulative from 1-minute bars during session)
    minCumulativeVolume: number; // 500000 = 500K shares cumulative during session
  };

  // Pattern Detection Parameters
  patterns: {
    // HOD (High of Day) related patterns
    hod: {
      // Distance from HOD to trigger "Near HOD" signals
      nearHodDistancePercent: number; // 0.5 = 0.5% from HOD

      // Maximum distance from HOD to still be considered "near"
      maxHodDistancePercent: number; // 2.0 = 2% from HOD
    };

    // Topping Tail patterns (1-minute)
    toppingTail: {
      // Minimum upper wick percentage of total candle range
      minUpperWickPercent: number; // 50.0 = 50%

      // Maximum body size as percentage of total range
      maxBodyPercent: number; // 40.0 = 40%

      // Must close red (below open)
      mustCloseRed: boolean; // true

      // Minimum volume per 1-minute bar
      minBarVolume: number; // 5000
    };

    // 5-Minute Topping Tail patterns
    // Definition: A candle that breaks HOD, gets rejected, and closes with a long upper wick
    toppingTail5m: {
      // REQUIREMENT 1: How far down the candle closes from its high
      // This measures rejection strength - higher % = stronger rejection
      // Example: 60.0 means close must be at least 60% down from candle high
      // If candle: H=10.00, L=9.00, range=1.00, then C must be ≤9.40 (60% down)
      minClosePercent: number; // 60.0 = close at least 60% down from high

      // REQUIREMENT 2: Must close red (below open)
      // When true: only red candles qualify (close < open)
      // When false: both red and green candles qualify
      mustCloseRed: boolean; // false = allow both red/green candles

      // REQUIREMENT 3: Minimum volume per 5-minute bar
      minBarVolume: number; // 5000 = minimum volume

      // REQUIREMENT 4: Maximum volume (filters data errors)
      maxBarVolume: number; // 50000000 = 50M shares max

      // REQUIREMENT 5: Upper shadow to body ratio
      // This ensures a true "topping tail" with significant upper wick
      // Upper shadow = distance from high to top of body
      // Body = |open - close|
      // Example: 1.5 means upper shadow ≥ 1.5x body size
      // If body=0.20, upper shadow must be ≥0.30
      minShadowToBodyRatio: number; // 1.5 = upper shadow ≥ 1.5x body

      // REQUIREMENT 6: HOD Break Requirement
      // true = candle HIGH must touch/exceed HOD (strict - recommended)
      // false = candle HIGH can be within maxHighDistanceFromHODPercent (loose)
      requireStrictHODBreak: boolean; // true = must break HOD

      // REQUIREMENT 7: Maximum distance from HOD for candle HIGH (only if requireStrictHODBreak = false)
      // Example: 2.0 means high can be up to 2% below OR above HOD
      maxHighDistanceFromHODPercent: number; // 2.0 = within 2% of HOD

      // REQUIREMENT 8: Maximum distance from HOD for candle CLOSE
      // This prevents candles that spike to HOD but close way below (no room to drop)
      // Example: 5.0 means close must be within 5% below HOD
      // This ensures there's still room for the stock to fall after the signal
      maxCloseDistanceFromHODPercent: number; // 5.0 = close within 5% of HOD

      // SUMMARY - A valid 5m topping tail must:
      // 1. Break HOD with candle high (if requireStrictHODBreak = true)
      // 2. Close at least minClosePercent% down from its high (rejection)
      // 3. Have upper shadow at least minShadowToBodyRatio times body size (long wick)
      // 4. Close within maxCloseDistanceFromHODPercent of HOD (not too far below)
      // 5. Meet volume requirements (minBarVolume to maxBarVolume)
      // 6. Optionally be red (if mustCloseRed = true)
    };

    // EMA(200 Daily) Tap-and-Reject pattern
    ema200TapReject: {
      // Maximum distance from EMA200 to consider a "tap" (in percentage)
      maxTapDistancePercent: number; // 0.5 = 0.5% from EMA200

      // Minimum number of bars to confirm rejection
      minRejectionBars: number; // 1 = immediate rejection

      // Must close below EMA200 after tap
      mustCloseBelowEMA: boolean; // true
    };

    // First New Low After Peak Volume Bar pattern
    firstNewLowAfterPeakVolume: {
      // Minimum volume multiplier to consider "peak volume"
      peakVolumeMultiplier: number; // 2.0 = 2x average volume

      // Distance from HOD to qualify peak volume bar (percentage)
      maxDistanceFromHODPercent: number; // 1.0 = within 1% of HOD

      // Number of previous bars to compare for "new low"
      barsForNewLowComparison: number; // 5 bars
    };

    // HOD Re-test Fail (lower-high) pattern
    hodRetestFail: {
      // Maximum distance from HOD for lower high (in dollars)
      maxLowerHighDistanceDollars: number; // 0.10 = 10 cents

      // Maximum distance from HOD for lower high (in percentage)
      maxLowerHighDistancePercent: number; // 0.3 = 0.3%

      // Must close red after lower high
      mustCloseRed: boolean; // true

      // Minimum time between HOD and retest (in minutes)
      minRetestDelayMinutes: number; // 5 minutes
    };
  };

  // API Configuration
  api: {
    // Retry configuration
    maxRetries: number; // 3

    // Timeout for API requests (in milliseconds)
    requestTimeout: number; // 30000 = 30 seconds

    // HTTP timeout for individual requests (in milliseconds)
    httpTimeout: number; // 10000 = 10 seconds

    // Polygon API limits
    aggregatesLimit: number; // 50000 = 50K bars per request
  };

  // Scanning Behavior
  scanning: {
    // How often to backfill for new signals (in milliseconds)
    // NOTE: The scanner now uses smart scheduling aligned to 5-minute candle boundaries
    // This config value is kept for compatibility but the actual scanning is optimized
    // to run 1 second after each 5-minute interval (9:30:01, 9:35:01, 9:40:01, etc.)
    backfillInterval: number; // 10000 = 10 seconds (legacy - now uses smart 5-min alignment + 1s)

    // Bid/ask spread for symbol data display
    bidAskSpread: number; // 0.01
  };

  // Historical Analysis
  historical: {
    // Maximum days to look back for historical data
    maxLookbackDays: number; // 730 = ~2 years

    // Number of symbols to analyze in historical scan
    maxSymbolsToAnalyze: number; // 20

    // Minimum daily volume threshold for historical candidate filtering
    // This filters stocks in Stage 1 BEFORE expensive minute-candle analysis
    // Set higher (e.g., 800000) to reduce candidates and speed up backtesting
    minDailyVolume: number; // 800000 = 800K shares

    // Minimum average volume threshold for symbol discovery (no longer used - discovery based on gap % only)
    minVolumeForDiscovery: number; // 25000 (deprecated, kept for compatibility)
  };

  // Development and Testing
  development: {
    // Enable debug logging
    enableDebugLogging: boolean; // true

    // Override current time for testing (ISO string or null)
    overrideCurrentTime: string | null; // "2024-09-25T14:00:00.000Z"

    // Enable test signal (fires on every new 5-minute candle for qualifying stocks)
    // Use this to verify the scanner is working and alerts are firing automatically
    // WARNING: This will generate MANY test alerts - only use for testing!
    enableTestSignal: boolean; // false = disabled, true = enabled
  };
}

/**
 * Default Scanner Configuration
 *
 * These are the default values. You can modify them here or create
 * environment-specific overrides.
 */
export const defaultScannerConfig: ScannerConfig = {
  marketHours: {
    startTime: '06:00', // 6:00 AM ET - Signal detection window start
    endTime: '10:00', // 10:00 AM ET - Signal detection window end
    timezone: 'America/New_York',
  },

  gapCriteria: {
    minGapPercentage: 10.0,
    maxGapPercentage: 10000.0,
    minPrice: 1.0,
    maxPrice: 60.0,
    minCumulativeVolume: 100000,
  },

  patterns: {
    hod: {
      nearHodDistancePercent: 3.0, // Tighter range: 3% instead of loose range
      maxHodDistancePercent: 10.0, // Maximum 10% from HOD
    },

    toppingTail: {
      minUpperWickPercent: 50.0,
      maxBodyPercent: 50.0,
      mustCloseRed: true,
      minBarVolume: 1000, // Lower requirement - rely on cumulative volume filtering
    },

    toppingTail5m: {
      minClosePercent: 0.0, // 60% down the candle
      mustCloseRed: false,
      minBarVolume: 5000,
      maxBarVolume: 50000000, // 50M shares max to filter data errors
      minShadowToBodyRatio: 1.5, // Upper shadow must be at least 0.5x the body
      requireStrictHODBreak: true, // Strict mode: high must break HOD
      maxHighDistanceFromHODPercent: 15.0, // High can be within 20% of HOD (only in loose mode)
      maxCloseDistanceFromHODPercent: 20.0, // Close must be within 15% of HOD
    },

    ema200TapReject: {
      maxTapDistancePercent: 0.5, // 0.5% from EMA200
      minRejectionBars: 1, // Immediate rejection
      mustCloseBelowEMA: true,
    },

    firstNewLowAfterPeakVolume: {
      peakVolumeMultiplier: 2.0, // 2x average volume
      maxDistanceFromHODPercent: 1.0, // Within 1% of HOD
      barsForNewLowComparison: 5, // Compare against last 5 bars
    },

    hodRetestFail: {
      maxLowerHighDistanceDollars: 0.1, // 10 cents
      maxLowerHighDistancePercent: 0.3, // 0.3%
      mustCloseRed: true,
      minRetestDelayMinutes: 5, // 5 minutes after HOD
    },
  },

  api: {
    maxRetries: 3,
    requestTimeout: 30000,
    httpTimeout: 10000,
    aggregatesLimit: 50000,
  },

  scanning: {
    backfillInterval: 10000, // Legacy config - now uses smart 5-min candle alignment
    bidAskSpread: 0.01,
  },

  historical: {
    maxLookbackDays: 730,
    maxSymbolsToAnalyze: 100, // Increased from 20 to 100 to capture more symbols
    minDailyVolume: 2000000, // 2M daily volume minimum (end-of-day total) - filters low-activity stocks for backtesting
    minVolumeForDiscovery: 25000, // Reduced from 50000 to 25000 for more discovery
  },

  development: {
    enableDebugLogging: true,
    overrideCurrentTime: null,
    enableTestSignal: false, // Set to true to test scanner/alert functionality
  },
};

/**
 * Get current scanner configuration
 *
 * This function returns the active configuration, allowing for
 * environment-specific overrides or runtime modifications.
 */
export const getScannerConfig = (): ScannerConfig => {
  // You can add environment-specific overrides here
  let config = { ...defaultScannerConfig };

  // Check for extended hours configuration
  const useExtendedHours = process.env.REACT_APP_USE_EXTENDED_HOURS === 'true';

  if (useExtendedHours) {
    console.log('🕐 Using EXTENDED HOURS configuration (4:00 AM - 4:00 PM ET)');
    config = { ...exampleConfigs.extendedHours };
  }

  // Example: Override for testing environment
  if (process.env.NODE_ENV === 'development') {
    // You can manually override hours here if needed
    // config.marketHours.endTime = "16:00"; // 4:00 PM for testing
    // config.gapCriteria.minGapPercentage = 20.0;
  }

  return config;
};

/**
 * Validation function for scanner configuration
 */
export const validateScannerConfig = (config: ScannerConfig): string[] => {
  const errors: string[] = [];

  // Validate market hours
  const startTime = parseTime(config.marketHours.startTime);
  const endTime = parseTime(config.marketHours.endTime);

  if (startTime === null) {
    errors.push(`Invalid start time format: ${config.marketHours.startTime}`);
  }
  if (endTime === null) {
    errors.push(`Invalid end time format: ${config.marketHours.endTime}`);
  }
  if (startTime && endTime && startTime >= endTime) {
    errors.push('Start time must be before end time');
  }

  // Validate gap criteria
  if (config.gapCriteria.minGapPercentage < 0) {
    errors.push('Minimum gap percentage must be positive');
  }
  if (
    config.gapCriteria.maxGapPercentage <= config.gapCriteria.minGapPercentage
  ) {
    errors.push('Maximum gap percentage must be greater than minimum');
  }
  if (config.gapCriteria.minPrice <= 0) {
    errors.push('Minimum price must be positive');
  }
  if (config.gapCriteria.maxPrice <= config.gapCriteria.minPrice) {
    errors.push('Maximum price must be greater than minimum price');
  }

  // Validate HOD pattern parameters
  if (config.patterns.hod.nearHodDistancePercent < 0) {
    errors.push('Near HOD distance percentage must be positive');
  }
  if (
    config.patterns.hod.maxHodDistancePercent <=
    config.patterns.hod.nearHodDistancePercent
  ) {
    errors.push('Max HOD distance must be greater than near HOD distance');
  }

  return errors;
};

/**
 * Helper function to parse time strings
 */
const parseTime = (timeString: string): number | null => {
  const match = timeString.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes; // Return minutes since midnight
};

/**
 * Example configurations for different scenarios
 */
export const exampleConfigs = {
  // Conservative settings for live trading
  conservative: {
    ...defaultScannerConfig,
    gapCriteria: {
      ...defaultScannerConfig.gapCriteria,
      minGapPercentage: 8.0,
      minPrice: 2.0,
      minCumulativeVolume: 200000,
    },
    patterns: {
      ...defaultScannerConfig.patterns,
      hod: {
        nearHodDistancePercent: 0.2,
        maxHodDistancePercent: 0.8,
      },
    },
  } as ScannerConfig,

  // Aggressive settings for more signals
  aggressive: {
    ...defaultScannerConfig,
    gapCriteria: {
      ...defaultScannerConfig.gapCriteria,
      minGapPercentage: 3.0,
      minPrice: 0.5,
      minCumulativeVolume: 50000,
    },
    patterns: {
      ...defaultScannerConfig.patterns,
      hod: {
        nearHodDistancePercent: 0.5,
        maxHodDistancePercent: 2.0,
      },
    },
  } as ScannerConfig,

  // Testing configuration with extended hours
  testing: {
    ...defaultScannerConfig,
    marketHours: {
      ...defaultScannerConfig.marketHours,
      startTime: '06:30',
      endTime: '09:25',
    },
    development: {
      ...defaultScannerConfig.development,
      enableDebugLogging: true,
    },
  } as ScannerConfig,

  // Extended hours for full day trading (premarket + regular market)
  extendedHours: {
    ...defaultScannerConfig,
    marketHours: {
      ...defaultScannerConfig.marketHours,
      startTime: '04:00', // 4:00 AM ET (premarket start)
      endTime: '20:00', // 8:00 PM ET (extended for after-hours testing)
    },
    gapCriteria: {
      ...defaultScannerConfig.gapCriteria,
      minGapPercentage: 20.0,
      minCumulativeVolume: 1000000,
    },
    api: {
      ...defaultScannerConfig.api,
    },
    scanning: {
      ...defaultScannerConfig.scanning,
    },
    historical: {
      ...defaultScannerConfig.historical,
    },
    development: {
      ...defaultScannerConfig.development,
      enableDebugLogging: true,
    },
  } as ScannerConfig,
};
