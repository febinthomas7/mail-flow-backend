const nodemailer = require("nodemailer");
const pLimit = require("p-limit");
const { injectData, generateBuffer } = require("../utils/generate");
const { createTags } = require("../utils/tags");

// Keep concurrency at 10 to avoid socket saturation
const limit = pLimit(25);

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
  const { smtpConfigs, subjects, senderNames, textBody, generationOptions } =
    payload;

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
    let attachments = [];

    const personalizedSubject = injectData(currentSubject, enrichedData);
    const personalizedBody = injectData(generationOptions.body, enrichedData);

    // 3. ATTACHMENT LOGIC
    if (generationOptions.format !== "html") {
      const fileBuffer = await generateBuffer(
        finalHtml,
        generationOptions.format,
      );
      if (fileBuffer !== null) {
        attachments.push({
          filename: `${enrichedData.invoice}.${generationOptions.format}`,
          content: fileBuffer,
        });
        emailBody = "Please find your document attached.";
      }
    }

    if (
      generationOptions.directFiles &&
      Array.isArray(generationOptions.directFiles)
    ) {
      generationOptions.directFiles.forEach((file) => {
        attachments.push({
          filename: file.name,
          content: file.base64.split(",")[1], // Extract actual base64 data
          encoding: "base64",
        });
      });
    }

    // 4. SENDING
    // const info = await transporter.sendMail({
    //   from: `"${currentSenderName}" <${currentSmtp.email}>`,
    //   to: recipient.email,
    //   subject: personalizedSubject,
    //   text: textBody ? personalizedBody : "",
    //   html: textBody ? "" : finalHtml,
    //   attachments: attachments,
    // });

    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log(
      `[MOCK] Success: ${recipient.email} | PDF Size: ${attachments[0]?.content.length || 0} bytes`,
    );

    return {
      email: recipient.email,
      status: "sent",
      messageId: `mock-id-${Date.now()}-${index}`,
    };
    // return {
    //   email: recipient.email,
    //   status: "sent",
    //   messageId: info.messageId,
    // };
  } catch (error) {
    return { email: recipient.email, status: "failed", error: error.message };
  }
};

const sendEmail = async (req, res) => {
  const { targets, ...rest } = req.body;
  const io = req.app.get("socketio"); // Get the IO instance we attached in index.js

  if (!targets || !Array.isArray(targets)) {
    return res
      .status(400)
      .json({ success: false, error: "Targets array is required." });
  }

  // 1. Instant response to prevent frontend timeout
  res.status(202).json({
    success: true,
    message: "MedLock Dispatcher: Batch sequence started in background.",
    total: targets.length,
  });

  // 2. Background Execution
  (async () => {
    try {
      console.log(
        `[RELAY] Launching blast for ${targets.length} recipients...`,
      );
      const startTime = Date.now();
      let totalProcessed = 0;

      const chunkSize = 500; // Smaller chunks = smoother UI updates
      for (let i = 0; i < targets.length; i += chunkSize) {
        const chunk = targets.slice(i, i + chunkSize);

        const tasks = chunk.map((recipient, chunkIndex) => {
          return limit(async () => {
            const globalIndex = i + chunkIndex;
            // Calculate which sender node this belongs to for the UI
            const senderIndex = globalIndex % rest.smtpConfigs.length;

            const result = await sendSingleEmail(recipient, globalIndex, rest);

            totalProcessed++;

            // 3. EMIT TO FRONTEND every 10 emails (balance performance vs smoothness)
            if (
              totalProcessed % 10 === 0 ||
              totalProcessed === targets.length
            ) {
              const elapsedMs = Date.now() - startTime;
              const avgMs = elapsedMs / totalProcessed;
              const remainingMins = (
                ((targets.length - totalProcessed) * avgMs) /
                60000
              ).toFixed(1);

              io.emit("batch_progress", {
                processed: totalProcessed,
                total: targets.length,
                senderIndex: senderIndex, // Matches your frontend batchPlans idx
                status: result.status,
                lastEmail: recipient.email,
                remainingMins: remainingMins,
                percentage: ((totalProcessed / targets.length) * 100).toFixed(
                  1,
                ),
              });
            }
            return result;
          });
        });

        await Promise.allSettled(tasks);

        console.log(
          `[PROGRESS] ${totalProcessed} / ${targets.length} complete.`,
        );

        if (i + chunkSize < targets.length) {
          await delay(500); // Small breather
        }
      }

      console.log(`[RELAY] Sequence complete.`);
      io.emit("batch_complete", { total: targets.length });
    } catch (err) {
      console.error("[CRITICAL] Background job failure:", err.message);
      io.emit("batch_error", { message: err.message });
    }
  })();
};

module.exports = { sendEmail };
