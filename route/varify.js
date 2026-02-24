const express = require('express');
const router = express.Router();
const verifyController = require('../controllers/verify');

router.post('/target', verifyController.verifyTargetEmail);
router.post('/smtp', verifyController.verifySmtp);

module.exports = router;