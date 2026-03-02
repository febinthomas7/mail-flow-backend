const express = require("express");
const router = express.Router();
const { Login } = require("../controllers/auth");
router.post("/admin", Login);

module.exports = router;
