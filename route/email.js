const express = require('express');
const router = express.Router();
const emailController = require('../controllers/sender');


router.post('/send', emailController);

module.exports = router;