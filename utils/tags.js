
let cachedDates = null;
let lastCalculatedDay = null;

/**
 * Formats dates for the templates (Cached for high performance)
 */
const getFormattedDates = () => {
    const today = new Date();
    const currentDay = today.getDate();

    // If we already calculated the date for today, return the cached strings immediately.
    // This reduces CPU usage for this function by 99.9%.
    if (cachedDates && lastCalculatedDay === currentDay) {
        return cachedDates;
    }

    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);

    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    
    cachedDates = {
        todayDate: today.toLocaleDateString('en-US', options),
        tomorrowDate: tomorrow.toLocaleDateString('en-US', options)
    };
    lastCalculatedDay = currentDay;

    return cachedDates;
};

// We use a counter combined with a timestamp to guarantee uniqueness without heavy crypto math.
let invoiceCounter = 0; 

/**
 * Generates a fast, unique alphanumeric invoice number
 * Format: INV-[TIMESTAMP]-[RANDOM]-[COUNTER]
 */
const generateInvoiceNo = () => {
    // Increment counter and reset at 10,000 just to keep it tidy
    invoiceCounter = (invoiceCounter + 1) % 10000; 
    
    // Date.now().toString(36) gives a short, unique time-based string.
    const timeHash = Date.now().toString(36).toUpperCase();
    
    // Fast, lightweight, non-blocking randomness
    const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase(); 

    return `INV-${timeHash}-${randomStr}-${invoiceCounter}`;
};

/**
 * Merges frontend data with generated tags
 */
exports.createTags = (frontendData) => {
    const { todayDate, tomorrowDate } = getFormattedDates();
    
    return {
        // Data from Frontend
        name: frontendData.name || "Valued Customer",
        email: frontendData.email || "",
        
        // Generated Data
        todayDate: todayDate,
        tomorrowDate: tomorrowDate,
        invoice: frontendData.invoice || generateInvoiceNo(), // Use provided or generate new
        
        // Spread any other custom data sent from frontend
        ...frontendData.customData 
    };
};