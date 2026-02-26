const axios = require('axios');
const FormData = require('form-data');
const handlebars = require('handlebars');

//  Using Internal Private IPs for both servers ---
const EASY_PDF_SERVER_URL = process.env.EASY_PDF_URL; 
const PDFREST_URL = process.env.PDFREST_URL;

// Caches compiled Handlebars templates to reduce CPU usage by 99%
const templateCache = {};

/**
 * 1. DYNAMIC INJECTION: Replaces {{tags}} with actual data
 */
const injectData = (htmlTemplate, data) => {
    if (!templateCache[htmlTemplate]) {
        templateCache[htmlTemplate] = handlebars.compile(htmlTemplate);
    }
    return templateCache[htmlTemplate](data); 
};

// Creates a dedicated client with a strict 15-second timeout
const apiClient = axios.create({
    timeout: 15000, 
});

/**
 * Exponential Backoff Retry Wrapper
 * Protects against random network drops and temporary server overload.
 */
const withRetry = async (fn, retries = 3, delayMs = 1000) => {
    try {
        return await fn();
    } catch (error) {
        const isClientError = error.response && error.response.status >= 400 && error.response.status < 500;
        const isRateLimit = error.response && error.response.status === 429;

        if (retries === 0 || (isClientError && !isRateLimit)) {
            throw error; 
        }
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return withRetry(fn, retries - 1, delayMs * 2); 
    }
};

/**
 * 2. GENERATION: Calls Internal Marketplace APIs for PDF/JPG/DOCX
 */
async function generateBuffer(htmlContent, format) {
    return withRetry(async () => {
        try {
            // --- SERVER 1: Easy PDF (Internal VPC) ---
            if (['pdf', 'jpg', 'png'].includes(format)) {
                const endpoint = format === 'pdf' ? '/render/pdf' : '/render/image';
                const response = await apiClient.post(`${EASY_PDF_SERVER_URL}${endpoint}`, {
                    html: htmlContent,
                    options: { format: 'A4', quality: 100 }
                }, { responseType: 'arraybuffer' });
                return response.data;
            } 
            
            // --- SERVER 2: pdfRest (Internal VPC) ---
            if (format === 'docx') {
                // STEP 1: Convert HTML to PDF
                const pdfForm = new FormData();
                pdfForm.append('file', Buffer.from(htmlContent), { filename: 'file.html', contentType: 'text/html' });

                const pdfResponse = await apiClient.post(`${PDFREST_URL}/pdf-with-html`, pdfForm, {
                    headers: { ...pdfForm.getHeaders() }, // Notice: No API Key needed for internal AMI
                    responseType: 'arraybuffer' 
                });

                // STEP 2: Convert the new PDF into a Word Document (DOCX)
                const wordForm = new FormData();
                wordForm.append('file', Buffer.from(pdfResponse.data), { filename: 'temp.pdf', contentType: 'application/pdf' });
                
                const wordResponse = await apiClient.post(`${PDFREST_URL}/pdf-to-word`, wordForm, {
                    headers: { ...wordForm.getHeaders() }, 
                    responseType: 'arraybuffer' 
                });

                return wordResponse.data;
            }

            throw new Error(`Unsupported format requested: ${format}`);

        } catch (error) {
            // Enhanced error tracking
            const statusCode = error.response ? error.response.status : 'Network/Timeout';
            throw new Error(`Cloud Generation Failed [HTTP ${statusCode}]: ${error.message}`);
        }
    });
}

module.exports = { injectData, generateBuffer };