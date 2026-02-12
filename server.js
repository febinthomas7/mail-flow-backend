const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();
const PORT = 3001;

// Enable CORS for frontend interaction
app.use(cors());
// Increased limit for large PDF attachments
app.use(express.json({ limit: "50mb" }));

/**
 * Professional SMTP Gateway Endpoint
 * Receives credentials and payload, dispatches via Nodemailer.
 */
app.post("/api/send-email", async (req, res) => {
  const { smtpConfig, mailOptions } = req.body;

  if (!smtpConfig || !mailOptions) {
    return res.status(400).json({
      success: false,
      error: "MISSING_PAYLOAD: SMTP config or Mail options are absent.",
    });
  }

  // Create transient transporter for this specific sender
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host || "smtp.gmail.com",
    port: smtpConfig.port || 587,
    secure: false, // true for 465, false for other ports
    auth: {
      user: smtpConfig.username,
      pass: smtpConfig.password,
    },
  });

  try {
    // Verify connection configuration
    // await transporter.verify();

    // Dispatch Mail
    const info = await transporter.sendMail({
      from: `"${smtpConfig.name || "MailFlow"}" <${smtpConfig.email}>`,
      to: mailOptions.to,
      subject: mailOptions.subject,
      text: mailOptions.text,
      html: mailOptions.html,
      attachments: mailOptions.attachments
        ? mailOptions.attachments.map((att) => ({
            filename: att.filename,
            content: att.content,
            encoding: "base64",
          }))
        : [],
      headers: {
        "List-Unsubscribe": `<mailto:${smtpConfig.email}>`,
        "X-Mailer": "MailFlow SMTP Gateway",
      },
    });

    console.log(
      `[RELAY_SUCCESS] ID: ${info.messageId} -> To: ${mailOptions.to} idhar hai`,
    );

    res.status(200).json({
      success: true,
      messageId: info.messageId,
    });
  } catch (error) {
    console.error(
      `[RELAY_ERROR] Node: ${smtpConfig.username} -> Error: ${error.message}`,
    );

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * SMTP Verification Endpoint
 * Checks if the credentials are valid without sending an email.
 */
app.post("/api/verify-smtp", async (req, res) => {
  const { smtpConfig } = req.body;

  if (!smtpConfig) {
    return res.status(400).json({
      success: false,
      error: "MISSING_PAYLOAD: SMTP config is absent.",
    });
  }

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host || "smtp.gmail.com",
    port: smtpConfig.port || 587,
    secure: false,
    auth: {
      user: smtpConfig.username,
      pass: smtpConfig.password,
    },
    // Interaction timeout to prevent hanging on bad proxies
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  try {
    // This attempts to log in to the SMTP server
    await transporter.verify();

    console.log(`[VERIFY_SUCCESS] Account: ${smtpConfig.username} is VALID.`);

    res.status(200).json({
      success: true,
      message: "Connection established successfully.",
    });
  } catch (error) {
    console.error(
      `[VERIFY_FAIL] Account: ${smtpConfig.username} -> ${error.message}`,
    );

    res.status(401).json({
      success: false,
      error: error.message || "Authentication failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`
  ==============================================
  MAILFLOW PRO BACKEND STARTED
  Port: ${PORT}
  Status: READY FOR RELAY
  ==============================================
  `);
});
