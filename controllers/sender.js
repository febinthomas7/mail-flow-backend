const nodemailer = require("nodemailer");
const pLimit = require("p-limit");
const { injectData, generateBuffer } = require("../utils/generate");
const { createTags } = require("../utils/tags");

const limit = pLimit(25);

const transporterCache = {};

let isPaused = false;
let limitReached = false;
let socketListenersInitialized = false;

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
  if (limitReached) {
    return {
      email: recipient.email,
      status: "skipped",
      reason: "limit_reached",
    };
  }

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
      attachments,
    });

    return {
      email: recipient.email,
      status: "sent",
      messageId: info.messageId,
    };
  } catch (error) {
    return {
      email: recipient.email,
      status: "failed",
      error: error.message,
    };
  }
};

const sendEmail = async (req, res) => {
  const { targets, maxLimit, smtpConfigs, ...rest } = req.body;
  const io = req.app.get("socketio");

  // 1. Initialize global flags
  global.limitReached = false;
  global.isPaused = false;
  global.isReset = false;

  if (!targets || !Array.isArray(targets)) {
    return res.status(400).json({ success: false, error: "Targets required." });
  }

  // 2. Prepare the Round Robin SMTP Pool
  let smtpPool = smtpConfigs.map((config) => ({
    ...config,
    sentCount: 0,
    maxLimit: parseInt(maxLimit) || 100,
  }));

  res.status(202).json({
    success: true,
    total: targets.length,
    message: "Dispatch started",
  });

  // 3. Process the Dispatch
  try {
    const startTime = Date.now();
    let totalProcessed = 0;
    const chunkSize = 500;

    for (let i = 0; i < targets.length; i += chunkSize) {
      // KILL SWITCH: Check before starting a new chunk
      if (global.isReset || global.limitReached) break;

      const chunk = targets.slice(i, i + chunkSize);

      const tasks = chunk.map((recipient, chunkIndex) =>
        limit(async () => {
          // KILL SWITCH: Check inside each task
          if (global.isReset || global.limitReached) return;

          // PAUSE LOGIC
          while (global.isPaused) {
            if (global.isReset) return;
            await delay(1000);
          }

          const globalIndex = i + chunkIndex;
          const availableSmtps = smtpPool.filter(
            (s) => s.sentCount < s.maxLimit,
          );

          if (availableSmtps.length === 0) {
            global.limitReached = true;
            return;
          }

          const selectedSmtp =
            availableSmtps[globalIndex % availableSmtps.length];
          selectedSmtp.sentCount++;

          // REAL EMAIL SENDING
          const result = await sendSingleEmail(
            recipient,
            globalIndex,
            rest,
            selectedSmtp,
          );

          // FINAL RESET CHECK
          if (global.isReset) return;

          totalProcessed++;
          const elapsedMs = Date.now() - startTime;
          const avgMs = elapsedMs / totalProcessed;

          io.emit("batch_progress", {
            processed: totalProcessed,
            total: targets.length,
            status: result?.status || "skipped",
            lastEmail: recipient.email,
            percentage: ((totalProcessed / targets.length) * 100).toFixed(1),
            remainingMins: (
              ((targets.length - totalProcessed) * avgMs) /
              60000
            ).toFixed(1),
          });
        }),
      );

      await Promise.allSettled(tasks);

      if (global.isReset) {
        console.log("🛑 Dispatch terminated by User Reset");
        // We still need to respond to the original HTTP request if we didn't send 202
        return res
          .status(200)
          .json({ success: true, message: "Reset acknowledged" });
      }

      if (global.limitReached) {
        io.emit("limit_reached", {
          message: "SMTP sending limit reached",
          processed: totalProcessed,
          total: targets.length,
        });
        break;
      }

      if (i + chunkSize < targets.length) {
        await delay(500);
      }
    }

    // 4. Final Response (Sent only after the loop finishes)
    return res.status(200).json({
      success: true,
      totalSent: totalProcessed,
      limitReached: global.limitReached,
    });
  } catch (err) {
    console.error("MailFlow Error:", err);
    io.emit("batch_error", { message: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
};
// const sendEmail = async (req, res) => {
//   const { targets, maxLimit, smtpConfigs } = req.body;
//   const io = req.app.get("socketio");

//   // 1. Initialize global flags for this specific execution
//   // These must match the variables your Socket listeners in server.js are toggling.
//   global.limitReached = false;
//   global.isPaused = false;
//   global.isReset = false;

//   // Basic Validation
//   if (!targets || !Array.isArray(targets)) {
//     return res.status(400).json({
//       success: false,
//       error: "Targets required.",
//     });
//   }

//   // 2. Prepare the SMTP Pool
//   let smtpPool = smtpConfigs.map((config) => ({
//     ...config,
//     sentCount: 0,
//     maxLimit: parseInt(maxLimit) || 100,
//   }));

//   // 3. Respond to the client immediately (HTTP 202 Accepted)
//   res.status(202).json({
//     success: true,
//     total: targets.length,
//   });

//   // 4. Start the Background Dispatch Process (IIFE)
//   (async () => {
//     try {
//       const startTime = Date.now();
//       let totalProcessed = 0;
//       const chunkSize = 500;

//       for (let i = 0; i < targets.length; i += chunkSize) {
//         // --- KILL SWITCH CHECK (Outer Loop) ---
//         if (global.isReset || global.limitReached) break;

//         const chunk = targets.slice(i, i + chunkSize);

//         const tasks = chunk.map((recipient, chunkIndex) =>
//           limit(async () => {
//             // --- KILL SWITCH CHECK (Inside Concurrent Tasks) ---
//             if (global.isReset || global.limitReached) return;

//             // --- PAUSE LOGIC ---
//             while (global.isPaused) {
//               // If user hits Reset while Paused, we must exit the while loop
//               if (global.isReset) return;
//               await delay(1000);
//             }

//             const globalIndex = i + chunkIndex;

//             // Check for available SMTPs in the pool
//             const availableSmtps = smtpPool.filter(
//               (s) => s.sentCount < s.maxLimit,
//             );

//             if (availableSmtps.length === 0) {
//               global.limitReached = true;
//               return;
//             }

//             const selectedSmtp =
//               availableSmtps[globalIndex % availableSmtps.length];
//             selectedSmtp.sentCount++;

//             // --- MOCK SENDING DELAY ---
//             await delay(Math.random() * 400 + 200);

//             // --- FINAL RESET CHECK ---
//             // Don't emit progress if the user just cleared the UI
//             if (global.isReset) return;

//             totalProcessed++;
//             const elapsedMs = Date.now() - startTime;
//             const avgMs = elapsedMs / totalProcessed;

//             // Update Frontend via Socket
//             io.emit("batch_progress", {
//               processed: totalProcessed,
//               total: targets.length,
//               status: "success",
//               lastEmail: recipient.email,
//               percentage: ((totalProcessed / targets.length) * 100).toFixed(1),
//               remainingMins: (
//                 ((targets.length - totalProcessed) * avgMs) /
//                 60000
//               ).toFixed(1),
//             });
//           }),
//         );

//         // Wait for the current chunk of 500 to finish (or be skipped)
//         await Promise.allSettled(tasks);

//         // Handle termination reasons
//         if (global.isReset) {
//           console.log("🛑 Dispatch terminated: User hit Reset");
//           return; // Exit the IIFE completely
//         }

//         if (global.limitReached) {
//           console.log("⚠️ Dispatch stopped: SMTP limit reached");
//           io.emit("limit_reached", {
//             message: "SMTP sending limit reached",
//             processed: totalProcessed,
//             total: targets.length,
//           });
//           break;
//         }

//         // Small cooling period between chunks
//         if (i + chunkSize < targets.length) {
//           await delay(500);
//         }
//       }

//       // Final Completion Signal
//       if (!global.limitReached && !global.isReset) {
//         io.emit("batch_complete", { total: targets.length });
//       }
//     } catch (err) {
//       console.error("MailFlow Error:", err);
//       io.emit("batch_error", { message: err.message });
//     }
//   })();
// };

module.exports = { sendEmail };
