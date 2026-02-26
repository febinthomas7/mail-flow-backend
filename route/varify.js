const express = require("express");
const router = express.Router();
const {
  verifyTargetWithSES,
  verifySmtpBatch,
} = require("../controllers/verify");

router.post("/target", verifyTargetWithSES);
router.post("/smtp", verifySmtpBatch);

module.exports = router;
