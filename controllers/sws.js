const sendEmail = async (req, res) => {
  const { targets, maxLimit, smtpConfigs } = req.body;
  const io = req.app.get("socketio");

  // 1. Initialize global flags for this specific execution
  // These must match the variables your Socket listeners in server.js are toggling.
  global.limitReached = false;
  global.isPaused = false;
  global.isReset = false;

  // Basic Validation
  if (!targets || !Array.isArray(targets)) {
    return res.status(400).json({
      success: false,
      error: "Targets required.",
    });
  }

  // 2. Prepare the SMTP Pool
  let smtpPool = smtpConfigs.map((config) => ({
    ...config,
    sentCount: 0,
    maxLimit: parseInt(maxLimit) || 100,
  }));

  // 3. Respond to the client immediately (HTTP 202 Accepted)
  res.status(202).json({
    success: true,
    total: targets.length,
  });

  // 4. Start the Background Dispatch Process (IIFE)
  (async () => {
    try {
      const startTime = Date.now();
      let totalProcessed = 0;
      const chunkSize = 500;

      for (let i = 0; i < targets.length; i += chunkSize) {
        // --- KILL SWITCH CHECK (Outer Loop) ---
        if (global.isReset || global.limitReached) break;

        const chunk = targets.slice(i, i + chunkSize);

        const tasks = chunk.map((recipient, chunkIndex) =>
          limit(async () => {
            // --- KILL SWITCH CHECK (Inside Concurrent Tasks) ---
            if (global.isReset || global.limitReached) return;

            // --- PAUSE LOGIC ---
            while (global.isPaused) {
              // If user hits Reset while Paused, we must exit the while loop
              if (global.isReset) return;
              await delay(1000);
            }

            const globalIndex = i + chunkIndex;

            // Check for available SMTPs in the pool
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

            // --- MOCK SENDING DELAY ---
            await delay(Math.random() * 400 + 200);

            // --- FINAL RESET CHECK ---
            // Don't emit progress if the user just cleared the UI
            if (global.isReset) return;

            totalProcessed++;
            const elapsedMs = Date.now() - startTime;
            const avgMs = elapsedMs / totalProcessed;

            // Update Frontend via Socket
            io.emit("batch_progress", {
              processed: totalProcessed,
              total: targets.length,
              status: "success",
              lastEmail: recipient.email,
              percentage: ((totalProcessed / targets.length) * 100).toFixed(1),
              remainingMins: (
                ((targets.length - totalProcessed) * avgMs) /
                60000
              ).toFixed(1),
            });
          }),
        );

        // Wait for the current chunk of 500 to finish (or be skipped)
        await Promise.allSettled(tasks);

        // Handle termination reasons
        if (global.isReset) {
          console.log("🛑 Dispatch terminated: User hit Reset");
          return; // Exit the IIFE completely
        }

        if (global.limitReached) {
          console.log("⚠️ Dispatch stopped: SMTP limit reached");
          io.emit("limit_reached", {
            message: "SMTP sending limit reached",
            processed: totalProcessed,
            total: targets.length,
          });
          break;
        }

        // Small cooling period between chunks
        if (i + chunkSize < targets.length) {
          await delay(500);
        }
      }

      // Final Completion Signal
      if (!global.limitReached && !global.isReset) {
        io.emit("batch_complete", { total: targets.length });
      }
    } catch (err) {
      console.error("MailFlow Error:", err);
      io.emit("batch_error", { message: err.message });
    }
  })();
};
