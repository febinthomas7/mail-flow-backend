const nodemailer = require("nodemailer");
const pLimit = require("p-limit");
const { injectData, generateBuffer } = require("../utils/generate");
const { createTags } = require("../utils/tags");

// Keep concurrency at 10 to avoid socket saturation
const limit = pLimit(10);

// --- Transporter Cache ---
// Reuses SMTP connections instead of logging in 20,000 times.
const transporterCache = {};

const getTransporter = (smtp) => {
  // Use email + host as a unique key for the cache
  const cacheKey = `${smtp.email}_${smtp.host}`;

  if (!transporterCache[cacheKey]) {
    transporterCache[cacheKey] = nodemailer.createTransport({
      host: "smtp.gmail.com" || "email-smtp.us-east-1.amazonaws.com", // Default to AWS SES
      port: smtp.port || 587,
      secure: smtp.port === 465,
      auth: {
        user: smtp.username || smtp.email, // Accepts extracted username or email
        pass: smtp.password, // Extracted from your Excel/CSV
      },
      // Optimization for bulk:
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }
  return transporterCache[cacheKey];
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendSingleEmail = async (recipient, index, payload) => {
  const { smtpConfigs, subjects, senderNames, generationOptions } = payload;

  // 1. ROTATION LOGIC
  const currentSmtp = smtpConfigs[index % smtpConfigs.length];
  const currentSubject = subjects[index % subjects.length];
  const currentSenderName = senderNames[index % senderNames.length];

  try {
    const transporter = getTransporter(currentSmtp);

    // 2. DATA EXTRACTION (Handles the 20k Object Array)
    const enrichedData = createTags({
      name: recipient?.name || "Valued Client",
      email: recipient?.email,
      invoice: recipient?.invoice || `INV-${Date.now()}`,
      customData: recipient?.data || {},
    });

    const finalHtml = injectData(generationOptions.html, enrichedData);
    // let emailBody = finalHtml;
    let attachments = [];

    const personalizedSubject = injectData(currentSubject, enrichedData);
    const personalizedBody = injectData(generationOptions.body, enrichedData);

    // 3. ATTACHMENT LOGIC
    if (generationOptions.format !== "html") {
      const fileBuffer = await generateBuffer(
        finalHtml,
        generationOptions.format,
      );
      attachments.push({
        filename: `${enrichedData.invoice}.${generationOptions.format}`,
        content: fileBuffer,
      });
      emailBody = "Please find your document attached.";
    }

    // 4. SENDING
    const info = await transporter.sendMail({
      from: `"${currentSenderName}" <${currentSmtp.email}>`,
      to: recipient.email,
      subject: personalizedSubject,
      text: personalizedBody,
      html: finalHtml,
      attachments: attachments,
    });

    return {
      email: recipient.email,
      status: "sent",
      messageId: info.messageId,
    };
  } catch (error) {
    return { email: recipient.email, status: "failed", error: error.message };
  }
};

const sendEmail = async (req, res) => {
  const { targets, ...rest } = req.body;

  if (!targets || !Array.isArray(targets)) {
    return res
      .status(400)
      .json({ success: false, error: "Targets array is required." });
  }
  // console.log(targets, rest);

  // Instant response to prevent frontend timeout
  res.status(202).json({
    success: true,
    message: "MedLock Dispatcher: Batch sequence started in background.",
    total: targets.length,
  });

  (async () => {
    try {
      console.log(
        `[RELAY] Launching blast for ${targets.length} recipients...`,
      );

      const chunkSize = 500;
      for (let i = 0; i < targets.length; i += chunkSize) {
        const chunk = targets.slice(i, i + chunkSize);

        const tasks = chunk.map((recipient, chunkIndex) => {
          return limit(() => sendSingleEmail(recipient, i + chunkIndex, rest));
        });

        const results = await Promise.allSettled(tasks);
        console.log(results);

        // LOGGING PROGRESS
        console.log(
          `[PROGRESS] Processed ${i + chunk.length} / ${targets.length}`,
        );

        if (i + chunkSize < targets.length) {
          await delay(1000); // Breathe space for SMTP servers
        }
      }
      console.log(`[RELAY] Sequence complete.`);
    } catch (err) {
      console.error("[CRITICAL] Background job failure:", err.message);
    }
  })();
};

module.exports = { sendEmail };
