const axios = require("axios");
const FormData = require("form-data");
const handlebars = require("handlebars");
const { Cluster } = require("puppeteer-cluster");

const PDFREST_URL = process.env.PDFREST_URL;

// --- Template Cache ---
const templateCache = {};

const injectData = (htmlTemplate, data, textBody) => {
  if (!htmlTemplate) return "";
  if (!templateCache[htmlTemplate]) {
    templateCache[htmlTemplate] = handlebars.compile(htmlTemplate);
  }
  return templateCache[htmlTemplate](data);
};

// --- Puppeteer Cluster Initialization ---
let cluster;

(async () => {
  try {
    cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_PAGE,
      // Match this to your p-limit(10) in the email file
      maxConcurrency: 15,
      puppeteerOptions: {
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", // Prevents EC2 memory crashes
          "--disable-gpu",
          '--js-flags="--max-old-space-size=512"',
        ],
      },
    });

    // Define the Cluster Task: What a tab does when given HTML
    await cluster.task(async ({ page, data: { htmlContent, format } }) => {
      await page.setContent(htmlContent, { waitUntil: "networkidle0" });

      if (format === "pdf") {
        return await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "20px", right: "20px", bottom: "20px", left: "20px" },
        });
      } else if (format === "jpg" || format === "png") {
        return await page.screenshot({
          type: format === "jpg" ? "jpeg" : "png",
          fullPage: true,
        });
      }
    });

    console.log("🛡️ Puppeteer Cluster Ready: Serving internal PDFs/Images.");
  } catch (err) {
    console.error("Failed to launch Puppeteer Cluster:", err);
  }
})();

// --- Dedicated API Client ---
const apiClient = axios.create({ timeout: 15000 });

const withRetry = async (fn, retries = 3, delayMs = 1000) => {
  try {
    return await fn();
  } catch (error) {
    const isClientError =
      error.response &&
      error.response.status >= 400 &&
      error.response.status < 500;
    const isRateLimit = error.response && error.response.status === 429;

    if (retries === 0 || (isClientError && !isRateLimit)) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return withRetry(fn, retries - 1, delayMs * 2);
  }
};

/**
 * 2. GENERATION: Calls Puppeteer internally, or PDFREST for DOCX
 */
async function generateBuffer(htmlContent, format) {
  if (!htmlContent) return null;

  try {
    // --- SERVER 1: Internal Puppeteer (Replaces Easy PDF) ---
    if (["pdf", "jpg", "png"].includes(format)) {
      if (!cluster) throw new Error("Puppeteer cluster is still booting up.");

      // Push the HTML and format to the queue and wait for the buffer
      const buffer = await cluster.execute({ htmlContent, format });
      return buffer;
    }

    // --- SERVER 2: pdfRest (Internal VPC for DOCX) ---
    if (format === "docx" || format === "word") {
      const pdfForm = new FormData();
      pdfForm.append("file", Buffer.from(htmlContent), {
        filename: "file.html",
        contentType: "text/html",
      });

      const pdfResponse = await apiClient.post(`${PDFREST_URL}/pdf`, pdfForm, {
        headers: { ...pdfForm.getHeaders() },
        responseType: "arraybuffer",
      });

      const wordForm = new FormData();
      wordForm.append("file", Buffer.from(pdfResponse.data), {
        filename: "temp.pdf",
        contentType: "application/pdf",
      });

      const wordResponse = await apiClient.post(
        `${PDFREST_URL}/word`,
        wordForm,
        {
          headers: { ...wordForm.getHeaders() },
          responseType: "arraybuffer",
        },
      );

      return wordResponse.data;
    }

    throw new Error(`Unsupported format requested: ${format}`);
  } catch (error) {
    console.error("Generation Error:", error.message || error);
    const statusCode = error.response ? error.response.status : "Internal";
    throw new Error(
      `Cloud Generation Failed [HTTP ${statusCode}]: ${error.message}`,
    );
  }
}

module.exports = { injectData, generateBuffer };
