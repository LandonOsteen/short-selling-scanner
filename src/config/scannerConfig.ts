/**
 * Scanner Configuration
 *
 * This file contains all configurable parameters for the premarket scanner.
 * Adjust these values to fine-tune the scanning behavior and signal detection.
 */

export interface ScannerConfig {
  // Market Hours Configuration
  marketHours: {
    // Scanning timeframe (24-hour format)
    startTime: string; // "04:00" for 4:00 AM
    endTime: string; // "09:30" for 9:30 AM
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

    // 5-Minute Topping Tail patterns (70% close down from high + shadow/body ratio + HOD proximity)
    toppingTail5m: {
      // Minimum close percentage (how far down the candle closes from high)
      minClosePercent: number; // 70.0 = 70% down from high (not enforcing red/green)

      // Must close red (below open) - NOTE: Currently not enforced in code
      mustCloseRed: boolean; // true (kept for config compatibility, but ignored)

      // Minimum volume per 5-minute bar
      minBarVolume: number; // 10000

      // Minimum upper shadow to body ratio
      // This ensures we only catch true rejection candles with significant wicks
      // Example: 1.5 means upper shadow must be at least 1.5x the body size
      minShadowToBodyRatio: number; // 1.5 = upper shadow must be 1.5x body

      // HOD proximity requirements
      // Maximum distance from HOD for the candle HIGH (allows near-misses)
      // Example: 2.0 means high can be up to 2% below OR above HOD
      maxHighDistanceFromHODPercent: number; // 2.0 = within 2% of HOD

      // Maximum distance from HOD for the candle CLOSE (prevents low closes)
      // Example: 10.0 means close must be within 10% below HOD
      // This prevents spikes to HOD that close way below
      maxCloseDistanceFromHODPercent: number; // 10.0 = close within 10% of HOD

      // REQUIREMENTS:
      // 1. Candle high must be within maxHighDistanceFromHODPercent of HOD
      // 2. Candle close must be within maxCloseDistanceFromHODPercent of HOD
      // 3. Must close at least minClosePercent% down from candle high
      // 4. Upper shadow must be at least minShadowToBodyRatio times the body size
      // 5. Allows both red and green candles
    };

    // Green candle run patterns (5-minute)
    greenRun: {
      // Minimum consecutive green candles before red
      minConsecutiveGreen: number; // 4

      // Maximum consecutive green candles to avoid over-extended moves
      maxConsecutiveGreen: number; // 20

      // Minimum total percentage gain during green run
      minRunGainPercent: number; // 1.0 = 1%

      // Must close red after green run
      mustCloseRed: boolean; // true

      // Maximum distance from HOD for green run high (in percentage)
      // HOD includes pre-market and previous day post-market trading
      maxDistanceFromHODPercent: number; // 3.0 = within 3% of HOD
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
    backfillInterval: number; // 10000 = 10 seconds for responsive real-time updates

    // Bid/ask spread for symbol data display
    bidAskSpread: number; // 0.01
  };

  // Historical Analysis
  historical: {
    // Maximum days to look back for historical data
    maxLookbackDays: number; // 730 = ~2 years

    // Number of symbols to analyze in historical scan
    maxSymbolsToAnalyze: number; // 20

    // Minimum average volume threshold for symbol discovery (no longer used - discovery based on gap % only)
    minVolumeForDiscovery: number; // 25000 (deprecated, kept for compatibility)
  };

  // Development and Testing
  development: {
    // Enable debug logging
    enableDebugLogging: boolean; // true

    // Override current time for testing (ISO string or null)
    overrideCurrentTime: string | null; // "2024-09-25T14:00:00.000Z"
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
    startTime: '09:30',
    endTime: '16:00',
    timezone: 'America/New_York',
  },

  gapCriteria: {
    minGapPercentage: 10.0,
    maxGapPercentage: 10000.0,
    minPrice: 1.0,
    maxPrice: 20.0,
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
      minClosePercent: 50.0, // 50% down the candle
      mustCloseRed: false,
      minBarVolume: 5000,
      minShadowToBodyRatio: 0.5, // Upper shadow must be at least 1.2x the body
      maxHighDistanceFromHODPercent: 10.0, // High must be within 2% of HOD
      maxCloseDistanceFromHODPercent: 10.0, // Close must be within 10% of HOD
    },

    greenRun: {
      minConsecutiveGreen: 4,
      maxConsecutiveGreen: 20,
      minRunGainPercent: 1.0,
      mustCloseRed: true,
      maxDistanceFromHODPercent: 3.0, // Only trigger near HOD (within 3%)
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
    backfillInterval: 10000, // Check for new signals every 10 seconds
    bidAskSpread: 0.01,
  },

  historical: {
    maxLookbackDays: 730,
    maxSymbolsToAnalyze: 100, // Increased from 20 to 100 to capture more symbols
    minVolumeForDiscovery: 25000, // Reduced from 50000 to 25000 for more discovery
  },

  development: {
    enableDebugLogging: true,
    overrideCurrentTime: null,
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
      endTime: '16:00', // 4:00 PM ET (market close)
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
