const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");
const MailComposer = require("nodemailer/lib/mail-composer");
const pLimit = require('p-limit'); 
const { injectData, generateBuffer } = require("../utils/generate");
const { createTags } = require("../utils/tags");

// Set concurrency limit: Only 10 emails process at exactly the same time.
const limit = pLimit(10); 

// --- SES Client Cache ---
// Prevents memory leaks by reusing clients instead of creating 20,000 of them.
const sesClientCache = {};

const getSesClient = (currentSmtp) => {
    const cacheKey = currentSmtp.accessKeyId;
    if (!sesClientCache[cacheKey]) {
        sesClientCache[cacheKey] = new SESClient({ 
            region: currentSmtp.region || "us-east-1",
            credentials: {
                accessKeyId: currentSmtp.accessKeyId,
                secretAccessKey: currentSmtp.secretAccessKey
            }
        });
    }
    return sesClientCache[cacheKey];
};

// --- Delay Helper ---
// Helps prevent AWS "ThrottlingException" by pausing slightly between chunks.
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * HELPER: Handles the logic for ONE specific email.
 * This is called by the queue.
 */
const sendSingleEmail = async (targetEmail, index, payload) => {
    const { smtpConfigs, subjects, senderNames, generationOptions } = payload;

    // 1. ROTATION LOGIC (Modulo)
    const currentSmtp = smtpConfigs[index % smtpConfigs.length];
    const currentSubject = subjects[index % subjects.length];
    const currentSenderName = senderNames[index % senderNames.length];

    try {
        const sesClient = getSesClient(currentSmtp);

        let finalHtml = "";
        let attachments = [];
        let emailBody = "";

        // 2. DYNAMIC TAGS & INJECTION
        if (generationOptions && generationOptions.html) {
            const enrichedData = createTags({
                name: generationOptions.receiverNames ? generationOptions.receiverNames[index % generationOptions.receiverNames.length] : "Customer",
                email: targetEmail,
                invoice: generationOptions.invoices ? generationOptions.invoices[index % generationOptions.invoices.length] : null,
                customData: generationOptions.data
            });

            finalHtml = injectData(generationOptions.html, enrichedData);

            // 3. FORMAT LOGIC
            if (generationOptions.format === 'html') {
                emailBody = finalHtml;
            } else {
                const fileBuffer = await generateBuffer(finalHtml, generationOptions.format);
                attachments.push({
                    filename: `${enrichedData.invoice}.${generationOptions.format}`,
                    content: fileBuffer,
                });
                emailBody = "Please find your document attached.";
            }
        }

        // 4. COMPOSE & SEND
        const mail = new MailComposer({
            from: `"${currentSenderName}" <${currentSmtp.email}>`,
            to: targetEmail,
            subject: currentSubject,
            html: emailBody,
            attachments: attachments
        });

        const compiledMessage = await mail.compile().build();
        const command = new SendRawEmailCommand({ RawMessage: { Data: compiledMessage } });
        const result = await sesClient.send(command);

        return { email: targetEmail, status: "sent", messageId: result.MessageId };

    } catch (error) {
        return { email: targetEmail, status: "failed", error: error.message };
    }
};

/**
 * MAIN EXPORT: The API endpoint that receives the 20k list.
 */
exports.sendEmail = async (req, res) => {
    const { targets, ...rest } = req.body;

    if (!targets || !Array.isArray(targets)) {
        return res.status(400).json({ success: false, error: "Targets array is required." });
    }

    // --- NEW: INSTANT RESPONSE (Fire and Forget) ---
    // Respond to the client immediately with a 202 (Accepted) status.
    // This prevents browser and server timeouts.
    res.status(202).json({ 
        success: true, 
        message: "Batch processing initiated. Emails are sending in the background.", 
        total: targets.length
    });

    // --- NEW: BACKGROUND WORKER ---
    // This self-executing function runs asynchronously without blocking the API response.
    (async () => {
        try {
            console.log(`[BACKGROUND JOB] Starting email blast for ${targets.length} targets...`);
            
            const finalReport = [];
            const chunkSize = 500; 
            
            for (let i = 0; i < targets.length; i += chunkSize) {
                const chunk = targets.slice(i, i + chunkSize);
                
                const tasks = chunk.map((targetEmail, chunkIndex) => {
                    const absoluteIndex = i + chunkIndex; 
                    return limit(() => sendSingleEmail(targetEmail, absoluteIndex, rest));
                });

                // Wait for the current chunk to finish
                const results = await Promise.allSettled(tasks);
                
                // Process results
                results.forEach((result) => {
                    finalReport.push(
                        result.status === 'fulfilled' ? result.value : { status: "error", error: result.reason }
                    );
                });

                // Add a small 1-second delay between chunks to let AWS breathe
                if (i + chunkSize < targets.length) {
                    await delay(1000); 
                }
            }

            console.log(`[BACKGROUND JOB] Finished processing ${targets.length} emails.`);
            
            // --- TODO: SAVE REPORT ---
            // Because we already sent the HTTP response, you must save the finalReport 
            // to your database here so the user can view it later in their dashboard.
            // Example: await db.collection('campaigns').updateOne({ _id: campaignId }, { $set: { report: finalReport, status: 'Completed' }});

        } catch (backgroundError) {
            console.error("[BACKGROUND JOB ERROR] Email queue failed:", backgroundError.message);
        }
    })(); 
};