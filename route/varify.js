const express = require('express');
const router = express.Router();
const verifyController = require('../controllers/verify');

router.post('/target', verifyController.verifyTargetWithSES);
router.post('/smtp', verifyController.verifySmtpBatch);

module.exports = router;