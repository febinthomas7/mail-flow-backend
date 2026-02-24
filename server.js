const express = require("express");
const cors = require("cors");
const verifyRoutes = require('./route/varify');
const emailRoutes = require('./route/email');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Routes
app.use('/api/verify', verifyRoutes);
app.use('/api/email', emailRoutes);

app.listen(PORT, () => {
    console.log(`
    ==============================================
    MAILFLOW PRO BACKEND STARTED
    Port: ${PORT}
    Status: READY FOR RELAY
    ==============================================
    `);
});