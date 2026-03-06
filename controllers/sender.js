const nodemailer = require("nodemailer");
const pLimit = require("p-limit");
const { injectData, generateBuffer } = require("../utils/generate");
const { createTags } = require("../utils/tags");

const limit = pLimit(25);
const transporterCache = {};
let isPaused = false; // Shared state for the background job

const getTransporter = (smtp) => {
  const cacheKey = `${smtp.email}_${smtp.host}`;
  if (!transporterCache[cacheKey]) {
    transporterCache[cacheKey] = nodemailer.createTransport({
      host: smtp.host || "smtp.gmail.com",
      port: smtp.port || 587,
      secure: smtp.port === 465,
      auth: {
        user: smtp.username || smtp.email,
        pass: smtp.password,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }
  return transporterCache[cacheKey];
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendSingleEmail = async (recipient, index, payload, currentSmtp) => {
  const { subjects, senderNames, textBody, generationOptions } = payload;
  const currentSubject = subjects[index % subjects.length];
  const currentSenderName = senderNames[index % senderNames.length];

  try {
    const transporter = getTransporter(currentSmtp);
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
      }
    }

    if (
      generationOptions.directFiles &&
      Array.isArray(generationOptions.directFiles)
    ) {
      generationOptions.directFiles.forEach((file) => {
        attachments.push({
          filename: file.name,
          content: file.base64.split(",")[1],
          encoding: "base64",
        });
      });
    }

    const info = await transporter.sendMail({
      from: `"${currentSenderName}" <${currentSmtp.email}>`,
      to: recipient.email,
      subject: personalizedSubject,
      text: textBody ? personalizedBody : "",
      html: textBody ? "" : finalHtml,
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
  const { targets, maxLimit, smtpConfigs, ...rest } = req.body;
  const io = req.app.get("socketio");

  // 1. SOCKET LISTENERS (The missing part)
  // We handle the connection to toggle the 'isPaused' flag
  io.on("connection", (socket) => {
    socket.on("pause_dispatch", () => {
      isPaused = true;
      console.log("⏸️ Dispatch PAUSED");
      io.emit("status_update", { status: "paused" });
    });

    socket.on("resume_dispatch", () => {
      isPaused = false;
      console.log("▶️ Dispatch RESUMED");
      io.emit("status_update", { status: "sending" });
    });
  });

  // 2. SMTP POOL INITIALIZATION
  let smtpPool = smtpConfigs.map((config) => ({
    ...config,
    sentCount: 0,
    maxLimit: parseInt(maxLimit) || 100,
  }));

  if (!targets || !Array.isArray(targets)) {
    return res.status(400).json({ success: false, error: "Targets required." });
  }

  res.status(202).json({ success: true, total: targets.length });

  // 3. BACKGROUND EXECUTION
  (async () => {
    try {
      const startTime = Date.now();
      let totalProcessed = 0;
      const chunkSize = 500;

      for (let i = 0; i < targets.length; i += chunkSize) {
        const chunk = targets.slice(i, i + chunkSize);

        const tasks = chunk.map((recipient, chunkIndex) => {
          return limit(async () => {
            // --- PAUSE CHECK ---
            while (isPaused) {
              await delay(1000);
            }

            const globalIndex = i + chunkIndex;

            // --- QUOTA-AWARE ROUND ROBIN ---
            const availableSmtps = smtpPool.filter(
              (s) => s.sentCount < s.maxLimit,
            );

            if (availableSmtps.length === 0) {
              throw new Error("All SMTP limits reached.");
            }

            const selectedSmtp =
              availableSmtps[globalIndex % availableSmtps.length];
            selectedSmtp.sentCount++; // Mark as used immediately

            const result = await sendSingleEmail(
              recipient,
              globalIndex,
              rest,
              selectedSmtp,
            );
            totalProcessed++;

            // Progress Update
            if (
              totalProcessed % 10 === 0 ||
              totalProcessed === targets.length
            ) {
              const elapsedMs = Date.now() - startTime;
              const avgMs = elapsedMs / totalProcessed;
              io.emit("batch_progress", {
                processed: totalProcessed,
                total: targets.length,
                status: result.status,
                lastEmail: recipient.email,
                percentage: ((totalProcessed / targets.length) * 100).toFixed(
                  1,
                ),
                remainingMins: (
                  ((targets.length - totalProcessed) * avgMs) /
                  60000
                ).toFixed(1),
              });
            }
            return result;
          });
        });

        await Promise.allSettled(tasks);
        if (i + chunkSize < targets.length) await delay(500);
      }
      io.emit("batch_complete", { total: targets.length });
    } catch (err) {
      console.error(err);
      io.emit("batch_error", { message: err.message });
    }
  })();
};

module.exports = { sendEmail };
