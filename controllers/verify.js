const {
  SESClient,
  GetIdentityVerificationAttributesCommand,
} = require("@aws-sdk/client-ses");
const nodemailer = require("nodemailer");
const pLimit = require("p-limit"); // --- NEW: Required for socket control
const verifier = require("email-verify");

// Initialize SES Client
const sesClient = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// --- NEW: Limit SMTP TCP connections to 5 at a time
// Opening network sockets is heavy; 5 is a safe number for concurrent handshakes.
const limitSmtp = pLimit(5);

/**
 * 1. Parallel SMTP Verification (Batch)
 * Expects an array of smtpConfigs in req.body.configs
 */
const verifySmtpBatch = async (req, res) => {
  const { configs } = req.body;

  if (!configs || !Array.isArray(configs)) {
    return res.status(400).json({
      success: false,
      error: "Provide an array of SMTP configurations.",
    });
  }

  // Function to verify a single transporter
  const checkSingleSmtp = async (config) => {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: config.port || 587,
      secure: config.port === 465,
      auth: { user: config.username, pass: config.password },
      connectionTimeout: 5000,
    });

    try {
      await transporter.verify();
      return { user: config.username, status: "valid" };
    } catch (err) {
      return { user: config.username, status: "invalid", error: err.message };
    } finally {
      // --- UPDATED: CRITICAL MEMORY FIX ---
      // Force the socket to close immediately after checking.
      // Prevents connection leaks that slowly choke the server.
      transporter.close();
    }
  };

  try {
    // --- UPDATED: Controlled parallel execution ---
    const tasks = configs.map((config) =>
      limitSmtp(() => checkSingleSmtp(config)),
    );
    const results = await Promise.allSettled(tasks);

    // Safely extract values, handling potential Promise rejections just in case
    const summary = results.map((res) =>
      res.status === "fulfilled" ? res.value : { error: res.reason },
    );

    res.status(200).json({ success: true, results: summary });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * 2. Amazon SES Identity Verification Check
 * Checks if the provided emails/domains are verified in your AWS SES account.
 */

const verifyTargetReal = async (req, res) => {
  const { email } = req.body;

  if (!email || !Array.isArray(email)) {
    return res
      .status(400)
      .json({ success: false, error: "Emails array is required." });
  }

  // 1. Extract email strings
  const emailStrings = email.map((item) =>
    typeof item === "string" ? item : item.email,
  );

  // 2. Wrap the callback-based library in a Promise
  const checkEmailReal = (addr) => {
    return new Promise((resolve) => {
      verifier.verify(addr, (err, info) => {
        if (err) {
          resolve({ email: addr, status: "invalid", msg: "Server Error" });
        } else if (info.success) {
          resolve({ email: addr, status: "valid", msg: "Real / Deliverable" });
        } else {
          // info.info contains the specific reason (e.g., "mailbox not found")
          resolve({
            email: addr,
            status: "invalid",
            msg: info.info || "Invalid Mailbox",
          });
        }
      });
    });
  };

  try {
    // 3. Process in parallel (Limit this if the list is very large > 50)
    const results = await Promise.all(emailStrings.map(checkEmailReal));

    res.json({ success: true, results });
  } catch (error) {
    console.error("Verification Error:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

module.exports = {
  verifySmtpBatch,
  verifyTargetReal,
};
