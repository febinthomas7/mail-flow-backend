const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

// Initialize SES Client
// Note: In production, use environment variables (process.env.AWS_ACCESS_KEY_ID, etc.)
// AWS SDK will automatically pick them up if they are in your .env file
const sesClient = new SESClient({ 
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

exports.sendEmail = async (req, res) => {
    const { smtpConfig, mailOptions } = req.body;

    // Validation
    if (!mailOptions || !mailOptions.to || !mailOptions.subject) {
        return res.status(400).json({ success: false, error: "MISSING_PAYLOAD" });
    }

    const params = {
        Source: `"${smtpConfig.name || "MailFlow"}" <${smtpConfig.email}>`, // Must be verified in SES
        Destination: {
            ToAddresses: Array.isArray(mailOptions.to) ? mailOptions.to : [mailOptions.to],
        },
        Message: {
            Subject: { Data: mailOptions.subject },
            Body: {
                Html: { Data: mailOptions.html || "" },
                Text: { Data: mailOptions.text || "" },
            },
        },
        // List-Unsubscribe and custom headers are handled differently in standard SendEmail.
        // For complex headers or attachments, you would typically use SendRawEmail.
    };

    try {
        const command = new SendEmailCommand(params);
        const data = await sesClient.send(command);

        console.log(`[SES_SUCCESS] MessageId: ${data.MessageId}`);
        res.status(200).json({ 
            success: true, 
            messageId: data.MessageId 
        });
    } catch (error) {
        console.error(`[SES_ERROR]`, error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
};