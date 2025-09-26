# Extended Hours Configuration

## Overview

The scanner now supports extended market hours operation from 4:00 AM to 4:00 PM ET, allowing you to monitor both premarket and regular market sessions continuously.

## Configuration

### Enable Extended Hours

Add this to your `.env` file:

```env
REACT_APP_USE_EXTENDED_HOURS=true
```

### Disable Extended Hours (Premarket Only)

Set to false or remove the variable:

```env
REACT_APP_USE_EXTENDED_HOURS=false
```

## Operating Modes

### Extended Hours Mode (4:00 AM - 4:00 PM ET)
- **Premarket Session**: 4:00 AM - 9:30 AM
- **Regular Market**: 9:30 AM - 4:00 PM
- **Live Streaming**: Real-time alerts throughout both sessions
- **Backfill**: Catches up on missed signals from session start

### Premarket Only Mode (4:00 AM - 9:30 AM ET)
- **Focus**: Pre-market gaps and patterns only
- **Traditional**: Original scanner behavior

## Restart Behavior

When you restart the scanner during market hours (e.g., at 1:32 PM):

1. **Automatic Backfill**: Fetches all historical signals from 4:00 AM to current time
2. **Live Streaming**: Switches to real-time mode for ongoing signals
3. **Complete Coverage**: No missed opportunities

## Session Detection

The scanner automatically detects which session you're in:

- **4:00-9:30 AM**: Premarket session
- **9:30 AM-4:00 PM**: Regular market session
- **4:00 PM-4:00 AM**: Market closed (historical mode only)

## Usage Examples

### Test Extended Hours at 1:32 PM

1. Set `REACT_APP_USE_EXTENDED_HOURS=true`
2. Restart the scanner
3. Check console logs for:
   - "🔄 Backfilling from 4:00:00 AM to 1:32:00 PM"
   - "📈 Currently in REGULAR MARKET session"
   - "✅ Should stream live alerts going forward"

### Switch Back to Premarket Only

1. Set `REACT_APP_USE_EXTENDED_HOURS=false`
2. Restart the scanner
3. Scanner will operate 4:00 AM - 9:30 AM only

## Benefits

- **Complete Market Coverage**: Don't miss gaps that develop during regular hours
- **Flexible Testing**: Test functionality at any time during the day
- **Seamless Restart**: No data loss when restarting mid-session
- **Session Awareness**: Optimized behavior for different market periods

## Technical Details

- **Live Data**: Uses Polygon gainers endpoint for real-time screening
- **Backfill**: Historical minute bars for pattern detection
- **Filtering**: Maintains same criteria (20%+ gap, 500K+ volume, $1-$20 price)
- **Performance**: Efficient caching and rate limiting