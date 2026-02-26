const router = require("express").Router();
const { sendEmail } = require("../controllers/sender");

router.post("/", sendEmail);

module.exports = router;
