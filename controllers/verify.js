const { SESClient, GetIdentityVerificationAttributesCommand } = require("@aws-sdk/client-ses");
const nodemailer = require("nodemailer");

// Initialize SES Client
const sesClient = new SESClient({ 
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

/**
 * 1. Parallel SMTP Verification (Batch)
 * Expects an array of smtpConfigs in req.body.configs
 */
exports.verifySmtpBatch = async (req, res) => {
    const { configs } = req.body; // Array of SMTP config objects

    if (!configs || !Array.isArray(configs)) {
        return res.status(400).json({ success: false, error: "Provide an array of SMTP configurations." });
    }

    // Function to verify a single transporter
    const checkSingleSmtp = async (config) => {
        const transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port || 587,
            secure: config.port === 465,
            auth: { user: config.username, pass: config.password },
            connectionTimeout: 5000, // Short timeout for speed
        });

        try {
            await transporter.verify();
            return { user: config.username, status: "valid" };
        } catch (err) {
            return { user: config.username, status: "invalid", error: err.message };
        }
    };

    try {
        // Parallel execution
        const results = await Promise.allSettled(configs.map(config => checkSingleSmtp(config)));
        
        const summary = results.map(res => res.value);
        res.status(200).json({ success: true, results: summary });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * 2. Amazon SES Identity Verification Check
 * Checks if the provided emails/domains are verified in your AWS SES account.
 */
exports.verifyTargetWithSES = async (req, res) => {
    const { emails } = req.body; // Array of emails to check status for

    if (!emails || !Array.isArray(emails)) {
        return res.status(400).json({ success: false, error: "Emails array is required." });
    }

    const params = { Identities: emails };

    try {
        const command = new GetIdentityVerificationAttributesCommand(params);
        const response = await sesClient.send(command);
        
        // AWS returns an object where keys are the emails
        res.status(200).json({ 
            success: true, 
            verificationData: response.VerificationAttributes 
        });
    } catch (error) {
        console.error("[SES_VERIFY_ERROR]", error);
        res.status(500).json({ success: false, error: error.message });
    }
};