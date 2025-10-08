/**
 * Example Configuration Usage
 *
 * This file demonstrates how to use different scanner configurations
 * for various scenarios like testing, production, or custom setups.
 */

import { GapScanner } from '../services/GapScanner';
import { exampleConfigs, getScannerConfig, ScannerConfig } from './scannerConfig';

// Example 1: Using the default configuration
export const createDefaultScanner = () => {
  return new GapScanner();
};

// Example 2: Using a predefined configuration (testing with extended hours)
export const createTestingScanner = () => {
  return new GapScanner(undefined, exampleConfigs.testing);
};

// Example 3: Creating a custom configuration
export const createCustomScanner = () => {
  const customConfig: ScannerConfig = {
    ...getScannerConfig(),

    // Custom market hours for testing (4:00 AM to 4:00 PM)
    marketHours: {
      startTime: "04:00",
      endTime: "16:00", // Extended to 4:00 PM for testing
      timezone: "America/New_York"
    },

    // Tighter gap criteria
    gapCriteria: {
      minGapPercentage: 3.0,     // Lower minimum gap (3% instead of 5%)
      maxGapPercentage: 30.0,    // Lower maximum gap
      minPrice: 2.00,            // Higher minimum price
      maxPrice: 15.00,           // Lower maximum price
      minCumulativeVolume: 75000, // Lower volume requirement
    },

    // Much tighter HOD range
    patterns: {
      ...getScannerConfig().patterns,
      hod: {
        nearHodDistancePercent: 0.2,  // Very tight: 0.2% from HOD
        maxHodDistancePercent: 0.8,   // Maximum 0.8% from HOD
      }
    },

    // Enable debug logging
    development: {
      enableDebugLogging: true,
      overrideCurrentTime: null, // Can set to "2024-09-25T14:00:00.000Z" for testing
      enableTestSignal: false, // Set to true to enable test signals for scanner verification
    }
  };

  return new GapScanner(undefined, customConfig);
};

// Example 4: Runtime configuration updates
export const demonstrateRuntimeUpdates = () => {
  const scanner = new GapScanner();

  // Update configuration at runtime
  scanner.updateConfig({
    marketHours: {
      startTime: "04:00",
      endTime: "16:00", // Extend hours for testing
      timezone: "America/New_York"
    },
    patterns: {
      ...scanner['config'].patterns, // Preserve other pattern settings
      hod: {
        nearHodDistancePercent: 0.1, // Super tight HOD range
        maxHodDistancePercent: 0.5,
      }
    }
  });

  return scanner;
};

// Example usage in your main App.tsx:
/*
// In App.tsx, replace:
// const [gapScanner] = useState(() => new GapScanner());

// With one of these options:

// Option 1: Default configuration
const [gapScanner] = useState(() => createDefaultScanner());

// Option 2: Testing configuration (extended hours)
const [gapScanner] = useState(() => createTestingScanner());

// Option 3: Custom tight configuration
const [gapScanner] = useState(() => createCustomScanner());

// Option 4: Update configuration for testing at runtime
useEffect(() => {
  // Temporarily extend hours to 4:00 PM for testing
  gapScanner.updateConfig({
    marketHours: {
      startTime: "04:00",
      endTime: "16:00",
      timezone: "America/New_York"
    }
  });
}, []);
*/

const examples = {
  createDefaultScanner,
  createTestingScanner,
  createCustomScanner,
  demonstrateRuntimeUpdates
};

export default examples;