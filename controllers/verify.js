const {
  SESClient,
  GetIdentityVerificationAttributesCommand,
} = require("@aws-sdk/client-ses");
const nodemailer = require("nodemailer");
const pLimit = require("p-limit"); // --- NEW: Required for socket control

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
    return res
      .status(400)
      .json({
        success: false,
        error: "Provide an array of SMTP configurations.",
      });
  }

  // Function to verify a single transporter
  const checkSingleSmtp = async (config) => {
    const transporter = nodemailer.createTransport({
      host: config.host,
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
const verifyTargetWithSES = async (req, res) => {
  const { emails } = req.body;

  if (!emails || !Array.isArray(emails)) {
    return res
      .status(400)
      .json({ success: false, error: "Emails array is required." });
  }

  try {
    // --- UPDATED: AWS API Limit Handling ---
    // AWS strictly limits 'Identities' to 100 items per request.
    const CHUNK_SIZE = 100;
    let allVerificationData = {};

    // Loop through the array 100 items at a time
    for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
      const chunk = emails.slice(i, i + CHUNK_SIZE);
      const params = { Identities: chunk };

      const command = new GetIdentityVerificationAttributesCommand(params);
      const response = await sesClient.send(command);

      // Merge the chunk's results into our master object
      allVerificationData = {
        ...allVerificationData,
        ...response.VerificationAttributes,
      };
    }

    res.status(200).json({
      success: true,
      verificationData: allVerificationData,
    });
  } catch (error) {
    console.error("[SES_VERIFY_ERROR]", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  verifySmtpBatch,
  verifyTargetWithSES,
};
