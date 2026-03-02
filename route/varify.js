const express = require("express");
const router = express.Router();
const { verifyTargetReal, verifySmtpBatch } = require("../controllers/verify");

router.post("/target", verifyTargetReal);
router.post("/smtp", verifySmtpBatch);

module.exports = router;
