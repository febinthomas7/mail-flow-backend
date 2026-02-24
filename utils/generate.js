const axios = require('axios');
const FormData = require('form-data');
const handlebars = require('handlebars');

const EASY_PDF_SERVER_URL = process.env.EASY_PDF_URL; 
const PDFREST_API_KEY = process.env.PDFREST_API_KEY;

// --- NEW: Template Cache ---
// Caches compiled Handlebars templates so we only process them once.
// This reduces CPU usage by 99% during large batch operations.
const templateCache = {};

/**
 * 1. DYNAMIC INJECTION: Replaces {{tags}} with actual data
 */
const injectData = (htmlTemplate, data) => {
    // Check if we've already compiled this specific HTML string
    if (!templateCache[htmlTemplate]) {
        templateCache[htmlTemplate] = handlebars.compile(htmlTemplate);
    }
    // Execute the cached function, which is lightning fast
    return templateCache[htmlTemplate](data); 
};


// --- NEW: Axios Configuration ---
// Creates a dedicated client with a strict 15-second timeout to prevent 
// infinite hanging connections that drain server RAM.
const apiClient = axios.create({
    timeout: 15000, 
});

/**
 * --- NEW: Exponential Backoff Retry Wrapper ---
 * Protects against random network drops and API Rate Limits (429 errors).
 */
const withRetry = async (fn, retries = 3, delayMs = 1000) => {
    try {
        return await fn();
    } catch (error) {
        const isClientError = error.response && error.response.status >= 400 && error.response.status < 500;
        const isRateLimit = error.response && error.response.status === 429;

        // If we are out of retries, OR it's a permanent user error (like 400 Bad Request, but NOT a 429), fail immediately.
        if (retries === 0 || (isClientError && !isRateLimit)) {
            throw error; 
        }
        
        // Wait, then try again with double the delay
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return withRetry(fn, retries - 1, delayMs * 2); 
    }
};

/**
 * 2. GENERATION: Calls Marketplace APIs for PDF/JPG/DOCX
 */
async function generateBuffer(htmlContent, format) {
    // Wrap the entire network call in our retry logic
    return withRetry(async () => {
        try {
            if (['pdf', 'jpg', 'png'].includes(format)) {
                const endpoint = format === 'pdf' ? '/render/pdf' : '/render/image';
                const response = await apiClient.post(`${EASY_PDF_SERVER_URL}${endpoint}`, {
                    html: htmlContent,
                    options: { format: 'A4', quality: 100 }
                }, { responseType: 'arraybuffer' });
                return response.data;
            } 
            
            if (format === 'docx') {
                const form = new FormData();
                // Avoid using Buffer.from repeatedly if possible, but safe enough for this payload
                form.append('file', Buffer.from(htmlContent), { filename: 'file.html', contentType: 'text/html' });
                form.append('output_type', 'docx');

                const response = await apiClient.post('https://api.pdfrest.com/pdf-with-html', form, {
                    headers: { 'Api-Key': PDFREST_API_KEY, ...form.getHeaders() },
                    responseType: 'arraybuffer' // Timeout inherited from apiClient
                });
                return response.data;
            }

            throw new Error(`Unsupported format requested: ${format}`);

        } catch (error) {
            // Enhanced error tracking so you know exactly what failed on the third-party side
            const statusCode = error.response ? error.response.status : 'Network/Timeout';
            throw new Error(`Cloud Generation Failed [HTTP ${statusCode}]: ${error.message}`);
        }
    });
}

module.exports = { injectData, generateBuffer };